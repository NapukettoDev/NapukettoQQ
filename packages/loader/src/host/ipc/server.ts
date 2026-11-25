/**
 * server.ts：IPC 服务端（self-host 子进程侧）。
 *
 * 职责（design.md §5.6 / §7）：
 *  - stdin 逐物理行收 action / control / ping
 *  - action → 动作表执行 → result 响应（请求 id 匹配）
 *  - control stop/restart → 关停（由驱动层决定是否重启）
 *  - control login → onLogin 回调（触发重新登录 / 强制扫码）
 *  - control status → 重播最近一条 status（父进程丢失重同步，2026-09-06）
 *  - ping → 自动回 pong
 *  - 心跳：定期发 ping（koishi 插件探活）
 */
import type { Readable } from "node:stream";
import {
    DEFAULT_MAX_IPC_LINE_BYTES,
    DEFAULT_MAX_PENDING_REQUESTS,
    type IpcActionMessage,
    type IpcControlPayload,
} from "../../contract/ipc-schema.js";
import { isShuttingDown, requestShutdown } from "../../lifecycle/shutdown.js";
import { log } from "../../shared/boot-log.js";
import { callIpcAction, type IpcActionHandler } from "./actions.js";
import { decodeIpcMessage } from "./codec.js";
import { readReadySelf, replayStatus, sendPing, sendPong, sendResult } from "./sender.js";

/** 心跳间隔（毫秒）。 */
const HEARTBEAT_INTERVAL_MS = 15_000;

/** control login 指令 payload（uin 指定账号，qr=true 强制扫码）。 */
export interface IpcLoginControlPayload {
    uin?: string;
    qr?: boolean;
}

/** IPC 服务端选项。 */
export interface IpcServerOptions {
    /** 动作表（createIpcActions 产物）。 */
    actions: Map<string, IpcActionHandler>;
    /** 心跳间隔（毫秒，默认 15s）。 */
    heartbeatMs?: number;
    input?: Readable;
    maxLineBytes?: number;
    maxPending?: number;
    /** control stop/restart 或 stdin 失效时关闭宿主。 */
    onExit?: (reason: string) => void;
    onLogin?: (payload: IpcLoginControlPayload) => void;
}

function createLineReader(
    maxBytes: number,
    onLine: (line: string) => void,
): (chunk: Buffer) => void {
    let parts: Buffer[] = [];
    let size = 0;

    function append(chunk: Buffer, start: number, end: number): void {
        if (size > maxBytes || end === start) {
            return;
        }
        size += end - start;
        if (size > maxBytes) {
            parts = [];
            log("[ipc] 丢弃超过物理行上限的 stdin 帧");
            return;
        }
        parts.push(chunk.subarray(start, end));
    }

    return (chunk) => {
        let start = 0;
        while (start < chunk.length) {
            const newline = chunk.indexOf(10, start);
            if (newline === -1) {
                append(chunk, start, chunk.length);
                return;
            }
            append(chunk, start, newline);
            if (size > 0 && size <= maxBytes) {
                onLine(Buffer.concat(parts, size).toString("utf8"));
            }
            parts = [];
            size = 0;
            start = newline + 1;
        }
    };
}

/** 启动 IPC 服务端。关闭时停止读取、心跳和发送未完成动作的响应。 */
export function startIpcServer(options: IpcServerOptions): () => void {
    const input = options.input ?? process.stdin;
    const onExit =
        options.onExit ??
        ((reason) => {
            void requestShutdown(reason);
        });
    const maxPending = options.maxPending ?? DEFAULT_MAX_PENDING_REQUESTS;
    let active = true;
    let pending = 0;

    async function dispatch({ id, payload }: IpcActionMessage): Promise<void> {
        if (pending >= maxPending) {
            sendResult(id, {
                ok: false,
                error: { code: "IPC_BUSY", message: "IPC 在途动作已达上限" },
            });
            return;
        }
        pending++;
        try {
            const result =
                payload.action === "login.getSelf"
                    ? getSelfResult()
                    : await callIpcAction(options.actions, payload.action, payload.params);
            if (active && !isShuttingDown()) {
                sendResult(id, result);
            }
        } finally {
            pending--;
        }
    }

    function stop(): void {
        if (!active) {
            return;
        }
        active = false;
        clearInterval(timer);
        input.off("data", onData);
        input.off("end", onInputLost);
        input.off("close", onInputLost);
        input.off("error", onInputLost);
        input.pause();
    }

    function exit(reason: string): void {
        stop();
        onExit(reason);
    }

    function onInputLost(): void {
        exit("IPC stdin 已断开");
    }

    const readLines = createLineReader(
        options.maxLineBytes ?? DEFAULT_MAX_IPC_LINE_BYTES,
        (line) => {
            if (!active || isShuttingDown()) {
                return;
            }
            const message = decodeIpcMessage(line);
            if (message === null) {
                log("[ipc] 忽略无法解析的 stdin 帧");
                return;
            }
            switch (message.type) {
                case "action":
                    dispatch(message).catch(() => log("[ipc] 动作调度失败"));
                    break;
                case "control":
                    handleControl(message.payload, () => exit("IPC 控制退出"), options.onLogin);
                    break;
                case "ping":
                    sendPong();
                    break;
                default:
                    break;
            }
        },
    );

    function onData(chunk: Buffer | string): void {
        readLines(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }

    const timer = setInterval(() => sendPing(), options.heartbeatMs ?? HEARTBEAT_INTERVAL_MS);
    input.once("end", onInputLost);
    input.once("close", onInputLost);
    input.once("error", onInputLost);
    input.on("data", onData);
    if (input.destroyed || input.readableEnded) {
        onInputLost();
    }
    return stop;
}

function getSelfResult() {
    const self = readReadySelf();
    return self === undefined
        ? { ok: false as const, error: { code: "INVALID_STATE", message: "当前会话身份未知" } }
        : { ok: true as const, value: { uin: self.uin, uid: self.uid, nickname: self.nick } };
}

/** 控制指令处理（stop/restart 退出；login 触发重新登录 / 强制扫码；status 重播）。 */
export function handleControl(
    payload: IpcControlPayload,
    onExit: () => void,
    onLogin?: (payload: IpcLoginControlPayload) => void,
): void {
    if (payload.command === "stop" || payload.command === "restart") {
        onExit();
        return;
    }
    // status：重播最近一条 status（父进程丢失 ready 等关键消息后主动重同步）
    if (payload.command === "status") {
        replayStatus();
        return;
    }
    // login：透传 uin/qr（可选字段用条件展开，exactOptionalPropertyTypes 不显式赋 undefined）
    if (payload.command === "login") {
        onLogin?.({
            ...(payload.uin !== undefined ? { uin: payload.uin } : {}),
            ...(payload.qr !== undefined ? { qr: payload.qr } : {}),
        });
    }
}
