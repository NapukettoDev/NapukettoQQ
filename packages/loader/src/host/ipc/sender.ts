/**
 * sender.ts：IPC 消息发送封装（self-host 子进程 → koishi 插件）。
 *
 * 仅 NAPUKETTO_IPC=1 启用：stdout 专用于 JSON 行协议（stdin 收 action/control）。
 * 非 IPC 模式（cli pnpm start）stdout 不输出协议行，零干扰。
 */

import {
    DEFAULT_MAX_IPC_LINE_BYTES,
    IPC_VERSION,
    type IpcBootPhase,
    type IpcLoginPayload,
    type IpcLogLevel,
    type IpcMessage,
    type IpcResultPayload,
    type IpcStatusPayload,
} from "../../contract/ipc-schema.js";
import { isShuttingDown } from "../../lifecycle/shutdown.js";
import { log } from "../../shared/boot-log.js";
import { encodeIpcMessage } from "./codec.js";

/** IPC 模式开关（self-host.ts 在 env.NAPUKETTO_IPC=1 时 enable）。 */
let enabled = false;

/** 最近一次 status payload 快照（control status 查询时重播）。
 * 防御场景：ready 等关键 status 消息被 stdout 并发写撕裂丢失（原生 printf
 * 直写 fd 等 JS 层拦不住的污染），父进程可主动查询重同步。 */
let lastStatus: IpcStatusPayload | null = null;
let eventForwardingEnabled = false;

let onOutputLost: (() => void) | undefined;

/** 启用 IPC；self-host 在首帧之前挂输出故障处理。 */
export function enableIpc(onLost?: () => void): void {
    enabled = true;
    if (onLost !== undefined && onOutputLost === undefined) {
        onOutputLost = onLost;
        process.stdout.on("error", loseOutput);
        process.stdout.once("close", loseOutput);
    }
}

function loseOutput(): void {
    if (enabled && onOutputLost !== undefined) {
        enabled = false;
        onOutputLost();
    }
}

/** 关停时尝试冲刷已排队的协议帧，由关停编排限制等待时间。 */
export async function flushIpc(): Promise<void> {
    if (enabled && process.stdout.writableLength > 0) {
        await new Promise<void>((resolve) => {
            process.stdout.write("", (error) => {
                if (error) {
                    loseOutput();
                }
                resolve();
            });
        });
    }
}

function sendIpc(message: IpcMessage): boolean {
    if (!enabled || isShuttingDown()) {
        return false;
    }
    let line: string;
    try {
        line = encodeIpcMessage(message);
    } catch {
        log("[ipc] 无法编码输出帧");
        return false;
    }
    try {
        if (onOutputLost === undefined) {
            process.stdout.write(line);
        } else {
            if (
                !process.stdout.writable ||
                process.stdout.writableLength > 2 * DEFAULT_MAX_IPC_LINE_BYTES
            ) {
                loseOutput();
                return false;
            }
            process.stdout.write(line, (error) => {
                if (error) {
                    loseOutput();
                }
            });
        }
        return true;
    } catch {
        loseOutput();
        return false;
    }
}

type SelfInfo = NonNullable<IpcLoginPayload["selfInfo"]>;

/** 从同一代已发布的 ready 快照读取身份。 */
export function readReadySelf(): SelfInfo | undefined {
    return lastStatus?.phase === "ready" && eventForwardingEnabled
        ? lastStatus.selfInfo
        : undefined;
}

/** 引导状态（booting/dlopening/logging/sessioning/ready/failed）。 */
export function sendStatus(
    phase: IpcBootPhase,
    message?: string,
    error?: { code: string; message: string },
    selfInfo?: SelfInfo,
): void {
    const payload: IpcStatusPayload = {
        phase,
        ...(phase === "ready" && selfInfo?.uin.trim() && selfInfo.uid.trim() ? { selfInfo } : {}),
        ...(message !== undefined ? { message } : {}),
        ...(error !== undefined ? { error } : {}),
    };
    eventForwardingEnabled = false;
    lastStatus = payload;
    replayStatus();
}

/** 重播最近一条 status（control status 查询响应；从未发送过则忽略）。 */
export function replayStatus(): void {
    const payload = lastStatus;
    if (payload !== null && sendIpc({ v: IPC_VERSION, type: "status", payload })) {
        if (payload.phase === "ready") {
            eventForwardingEnabled = true;
        }
    }
}

/** 最近一次 status 的 phase（从未发送过为 null）。
 * 引导失败决策用：判断「是否已发过更具体的 failed」，避免通用 failed 覆盖具体错误码。 */
export function lastIpcStatusPhase(): IpcBootPhase | null {
    return lastStatus?.phase ?? null;
}

/** 引导未完成时是否补发通用 failed：仅 IPC 模式且最近一条不是 failed
 * （已发过带具体错误码的 failed 时不覆盖，如登录失败的 NOT_LOGIN）。 */
export function shouldSendGenericBootFailed(
    ipcMode: boolean,
    lastPhase: IpcBootPhase | null,
): boolean {
    return ipcMode && lastPhase !== "failed";
}

/** 登录状态（QR 状态机 idle/waiting_scan/scanned/logged_in/failed）。 */
export function sendLogin(
    state: "idle" | "waiting_scan" | "scanned" | "logged_in" | "failed",
    selfInfo?: { uin: string; uid: string; nick: string },
    message?: string,
): void {
    sendIpc({
        v: IPC_VERSION,
        type: "login",
        payload: {
            state,
            ...(selfInfo !== undefined ? { selfInfo } : {}),
            ...(message !== undefined ? { message } : {}),
        },
    });
}

/** 二维码数据（扫码登录展示用）。 */
export function sendQr(pngBase64: string, qrcodeUrl: string): void {
    sendIpc({ v: IPC_VERSION, type: "qr", payload: { pngBase64, qrcodeUrl } });
}

/** kernel / OB11 事件统一在 ready 写出后转发。装配期间的事件不积压。 */
export function sendEvent(service: string, name: string, args: unknown[]): void {
    if (!eventForwardingEnabled) {
        return;
    }
    sendIpc({ v: IPC_VERSION, type: "event", payload: { service, name, args } });
}

/** 结构化日志转发（pino level）。 */
export function sendLog(level: IpcLogLevel, message: string): void {
    sendIpc({ v: IPC_VERSION, type: "log", payload: { level, message } });
}

/** 动作响应。 */
export function sendResult(id: number, payload: IpcResultPayload): void {
    sendIpc({ v: IPC_VERSION, type: "result", id, payload });
}

/** 心跳应答（收到 ping 时回）。 */
export function sendPong(): void {
    sendIpc({ v: IPC_VERSION, type: "pong" });
}

/** 心跳（定期发送，koishi 插件探活）。 */
export function sendPing(): void {
    sendIpc({ v: IPC_VERSION, type: "ping" });
}
