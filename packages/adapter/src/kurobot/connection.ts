/**
 * KurobotConnection：kurobridge-ws 客户端连接层（任务书 KUROBOT-PROMPT §1.2 决策二）
 *
 * 自建而不复用 network.WsClient 的四个协议语义理由（均已核实 WsClient 现状）：
 * ① 服务端 handleProtocols 校验子协议 `kurobridge-ws.v1`，不带直接拒连——WsClient
 *    不支持 Sec-WebSocket-Protocol；
 * ② 服务端空闲检测（30s）只认**应用层入帧**，WS 层 ws.ping() 不重置计时——必须发
 *    应用层 ping 帧；
 * ③ 每次连接（含重连）成功后必须立即重发 hello——WsClient 无 onOpen 回调；
 * ④ 重连需感知 close code（1002/1008 停止重连）——WsClient 是固定延迟重连。
 * 这四项都是 kurobridge-ws 协议语义，塞进协议无关的 network 违反其定位（红线：不改 network）。
 *
 * 状态机：connecting → establishing（hello 已发，等 ack）→ established（应用层 ping）
 * ↔ backoff（指数退避 1s/2s/…/60s 封顶）；hello_ack ok:false / close 1002 / 1008 →
 * 永久停止（等版本升级或配置修正，error 日志）。未 established 时发送直接丢弃（不积压）。
 */
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
    type BindingsUpdatedBody,
    bindingsUpdatedFrame,
    type CommandResultBody,
    commandResultFrame,
    type DeathBody,
    deathFrame,
    encodeFrame,
    type GameChatBody,
    gameChatFrame,
    type HelloAckOkBody,
    helloAckFrame,
    isProtocolVersionCompatible,
    type JoinBody,
    joinFrame,
    type LeaveBody,
    leaveFrame,
    type PongBody,
    pongFrame,
    type QueryResultBody,
    queryResultFrame,
    type StatusBody,
    statusFrame,
    WS_SUBPROTOCOL,
    wireFrameSchema,
} from "./schema.js";

/** 连接层日志最小面（装配方传 pino 实例；缺省静默）。 */
export interface KurobotLogger {
    debug(obj: unknown, msg: string): void;
    info(obj: unknown, msg: string): void;
    warn(obj: unknown, msg: string): void;
    error(obj: unknown, msg: string): void;
}

/** 服务端 → 对端的已知业务帧（扁平消息；hello_ack 由连接层内部消费不经此回调）。 */
export type ServerEventMessage =
    | { type: "pong"; id: string; body: PongBody }
    | { type: "chat"; body: GameChatBody }
    | { type: "join"; body: JoinBody }
    | { type: "leave"; body: LeaveBody }
    | { type: "death"; body: DeathBody }
    | { type: "status"; body: StatusBody }
    | { type: "bindings_updated"; body: BindingsUpdatedBody }
    | { type: "command_result"; id: string; body: CommandResultBody }
    | { type: "query_result"; id: string; body: QueryResultBody };

/** 连接终止原因（onEnded 只在永久停止时触发一次；用户 stop() 不触发）。 */
export interface ConnectionEndedReason {
    /** true = 不可恢复（版本不符 / token 错 / hello_ack 拒绝）。 */
    permanent: boolean;
    /** WS close code（可得时）。 */
    code?: number;
    /** 人读描述。 */
    detail: string;
}

/** hello body（protocolVersion 固定 0.3.1；peerId/platform/version/client 由适配器解析）。 */
export interface KurobotHello {
    peerId: string;
    platform: string;
    version: string;
    protocolVersion: string;
    token?: string;
    client?: string;
}

/** 连接层参数（重连节奏等可注入测试快值；生产用缺省）。 */
export interface KurobotConnectionOptions {
    /** KuroBot 服务端完整地址（ws:// / wss://）。 */
    url: string;
    hello: KurobotHello;
    /** 应用层心跳间隔毫秒（须显著小于服务端 30s 空闲阈值；0 = 关闭）。 */
    pingIntervalMs: number;
    /** 建立（hello → ack）超时毫秒。 */
    helloTimeoutMs: number;
    /** 重连退避基数毫秒（指数 2^attempt）。 */
    retryBaseDelayMs: number;
    /** 重连退避上限毫秒。 */
    retryMaxDelayMs: number;
    /** 握手成功（ack ok，含绑定快照）。 */
    onEstablished: (ack: HelloAckOkBody) => void;
    /** 服务端业务帧（hello_ack 内部消费不回调；pong 透传由消费方忽略）。 */
    onFrame: (msg: ServerEventMessage) => void;
    /** 连接永久停止（1002/1008/hello_ack 拒绝）；用户 stop() 不触发。 */
    onEnded: (reason: ConnectionEndedReason) => void;
    /** 日志（缺省静默）。 */
    logger?: KurobotLogger;
}

/** 连接层内部状态。 */
type ConnectionState =
    | "idle"
    | "connecting"
    | "establishing"
    | "established"
    | "backoff"
    | "stopped";

/**
 * 已知 type → 具体 schema 校验（返回扁平消息；body 非法返回 null 由调用方统一 warn）。
 * 与 schema.ts 的 Server→Peer 消息集一一对应；hello_ack 在连接层单独处理，不在此表。
 */
const SERVER_FRAME_PARSERS: Record<string, (json: unknown) => ServerEventMessage | null> = {
    pong: (json) => {
        const ok = pongFrame.safeParse(json);
        return ok.success ? { type: "pong", id: ok.data.id, body: ok.data.body } : null;
    },
    chat: (json) => {
        const ok = gameChatFrame.safeParse(json);
        return ok.success ? { type: "chat", body: ok.data.body } : null;
    },
    join: (json) => {
        const ok = joinFrame.safeParse(json);
        return ok.success ? { type: "join", body: ok.data.body } : null;
    },
    leave: (json) => {
        const ok = leaveFrame.safeParse(json);
        return ok.success ? { type: "leave", body: ok.data.body } : null;
    },
    death: (json) => {
        const ok = deathFrame.safeParse(json);
        return ok.success ? { type: "death", body: ok.data.body } : null;
    },
    status: (json) => {
        const ok = statusFrame.safeParse(json);
        return ok.success ? { type: "status", body: ok.data.body } : null;
    },
    bindings_updated: (json) => {
        const ok = bindingsUpdatedFrame.safeParse(json);
        return ok.success ? { type: "bindings_updated", body: ok.data.body } : null;
    },
    command_result: (json) => {
        const ok = commandResultFrame.safeParse(json);
        return ok.success ? { type: "command_result", id: ok.data.id, body: ok.data.body } : null;
    },
    query_result: (json) => {
        const ok = queryResultFrame.safeParse(json);
        return ok.success ? { type: "query_result", id: ok.data.id, body: ok.data.body } : null;
    },
};

/** kurobridge-ws 客户端连接（子协议 + hello + 应用层 ping + 感知 close code 的指数退避）。 */
export class KurobotConnection {
    private readonly opts: KurobotConnectionOptions;
    private readonly log: KurobotLogger;
    private state: ConnectionState = "idle";
    private ws: WebSocket | null = null;
    /** 用户主动 stop（其后一切 close 都不再重连、不上报 onEnded）。 */
    private userStopped = false;
    /** 已判定永久拒绝（版本/token），不再重连。 */
    private rejected = false;
    private pendingHelloId: string | null = null;
    private helloTimer: NodeJS.Timeout | null = null;
    private pingTimer: NodeJS.Timeout | null = null;
    private retryTimer: NodeJS.Timeout | null = null;
    /** 连续失败计数（established 成功后清零）。 */
    private attempt = 0;

    constructor(opts: KurobotConnectionOptions) {
        this.opts = opts;
        this.log = opts.logger ?? SILENT_LOGGER;
    }

    /** 当前是否已建立（ack ok）。 */
    isEstablished(): boolean {
        return this.state === "established";
    }

    /** 启动：发起首次连接（异步，结果经回调上报；重复调用幂等）。 */
    start(): void {
        if (this.state !== "idle") {
            return;
        }
        this.connect();
    }

    /** 停止：关闭连接、清定时器、不再重连（幂等；不触发 onEnded）。 */
    stop(): void {
        if (this.state === "stopped") {
            return;
        }
        this.userStopped = true;
        this.clearTimers();
        this.state = "stopped";
        const ws = this.ws;
        this.ws = null;
        ws?.close(1000, "client stop");
    }

    /** 发送出站帧（chat/command/query 等扁平消息）；未 established 丢弃 + debug。 */
    send(message: { type: string; body: unknown; id?: string }): boolean {
        const ws = this.ws;
        if (this.state !== "established" || ws === null || ws.readyState !== WebSocket.OPEN) {
            this.log.debug({ type: message.type }, "kurobot: 未建立连接，丢弃出站帧");
            return false;
        }
        ws.send(encodeFrame(message));
        return true;
    }

    /** 发起一次连接。 */
    private connect(): void {
        if (this.userStopped || this.rejected) {
            return;
        }
        this.state = "connecting";
        const ws = new WebSocket(this.opts.url, WS_SUBPROTOCOL);
        this.ws = ws;
        ws.on("open", () => {
            this.onOpen();
        });
        ws.on("message", (data: unknown) => {
            this.onText(String(data));
        });
        ws.on("close", (code: number, reason: Buffer) => {
            this.onClose(code, reason.toString());
        });
        ws.on("error", (err: Error) => {
            // close 总会跟随 error 到达（连接失败 / 中途断开），状态迁移统一在 onClose
            this.log.warn({ err: err.message }, "kurobot: 连接错误");
        });
    }

    /** 连接建立：立即发 hello（每次连接都重发——服务端按连接会话握手）。 */
    private onOpen(): void {
        if (this.ws === null || this.userStopped || this.rejected) {
            return;
        }
        this.state = "establishing";
        this.pendingHelloId = randomUUID();
        this.ws.send(
            encodeFrame({ type: "hello", id: this.pendingHelloId, body: this.opts.hello }),
        );
        // 握手超时兜底（服务端也有 10s hello 超时，双保险）
        this.helloTimer = setTimeout(() => {
            this.helloTimer = null;
            if (this.state === "establishing") {
                this.log.warn({}, "kurobot: 等待 hello_ack 超时，关闭重试");
                this.ws?.close();
            }
        }, this.opts.helloTimeoutMs);
    }

    /** 收到文本帧：两段式解析（wire 取 type → 分发具体 schema）+ 未知帧容忍。 */
    private onText(text: string): void {
        let json: unknown;
        try {
            json = JSON.parse(text) as unknown;
        } catch {
            this.log.warn({ text: text.slice(0, 200) }, "kurobot: 非法 JSON 帧，忽略");
            return;
        }
        const wire = wireFrameSchema.safeParse(json);
        if (!wire.success) {
            this.log.warn({ text: text.slice(0, 200) }, "kurobot: 帧骨架非法，忽略");
            return;
        }
        const { type } = wire.data.header;
        if (type === "hello") {
            this.log.warn({}, "kurobot: 收到非预期的 hello 帧，忽略");
            return;
        }
        if (type === "hello_ack") {
            this.handleHelloAck(json);
            return;
        }
        const msg = this.parseServerFrame(type, json);
        if (msg !== null) {
            this.opts.onFrame(msg);
        }
    }

    /** 已知 type 的具体 schema 校验（未知 type 走容忍；body 非法 warn 丢弃）。 */
    private parseServerFrame(type: string, json: unknown): ServerEventMessage | null {
        const parser = SERVER_FRAME_PARSERS[type];
        if (parser === undefined) {
            this.handleUnknownFrame(type, headerId(json));
            return null;
        }
        const msg = parser(json);
        if (msg === null) {
            this.log.warn({ type }, "kurobot: 已知帧 body 校验失败，丢弃");
        }
        return msg;
    }

    /** 未知帧容忍（对齐 ADR-026 服务端策略）：事件帧忽略；请求帧回 `<type>_result` 失败回执；`_result` 结尾不回执（防乒乓）。 */
    private handleUnknownFrame(type: string, id: string | undefined): void {
        if (id === undefined) {
            this.log.debug({ type }, "kurobot: 未知事件帧，忽略");
            return;
        }
        if (type.endsWith("_result")) {
            this.log.debug({ type }, "kurobot: 未知响应帧，忽略（不回执防乒乓）");
            return;
        }
        this.log.debug({ type }, "kurobot: 未知请求帧，回执 unknown frame type");
        this.send({ type: `${type}_result`, id, body: { ok: false, error: "unknown frame type" } });
    }

    /** hello_ack 处理：ok → 建立；ok:false → 永久停止（版本/鉴权问题不可自愈）。 */
    private handleHelloAck(json: unknown): void {
        const parsed = helloAckFrame.safeParse(json);
        if (!parsed.success) {
            this.log.warn({ type: "hello_ack" }, "kurobot: 已知帧 body 校验失败，丢弃");
            return;
        }
        if (parsed.data.id !== this.pendingHelloId) {
            this.log.warn({}, "kurobot: hello_ack id 与请求不匹配，忽略");
            return;
        }
        if (!parsed.data.body.ok) {
            this.log.error({ reason: parsed.data.body.reason }, "kurobot: 握手被拒，停止重连");
            this.reject(`hello_ack: ${parsed.data.body.reason}`);
            return;
        }
        const ack = parsed.data.body;
        if (!isProtocolVersionCompatible(this.opts.hello.protocolVersion, ack.protocolVersion)) {
            // 主版本协商在服务端（已接受才会回 ok），此处仅告警异常不一致
            this.log.warn(
                { peer: ack.protocolVersion, self: this.opts.hello.protocolVersion },
                "kurobot: hello_ack 版本与本地声明主版本不一致",
            );
        }
        if (this.helloTimer !== null) {
            clearTimeout(this.helloTimer);
            this.helloTimer = null;
        }
        this.attempt = 0;
        this.state = "established";
        this.startPing();
        this.log.info(
            { serverId: ack.serverId, version: ack.version, protocolVersion: ack.protocolVersion },
            "kurobot: 握手成功",
        );
        this.opts.onEstablished(ack);
    }

    /** 应用层心跳：每 pingIntervalMs 发 ping 帧（服务端任何入帧重置 30s 空闲计时）。 */
    private startPing(): void {
        this.stopPing();
        if (this.opts.pingIntervalMs <= 0) {
            return;
        }
        this.pingTimer = setInterval(() => {
            if (this.state === "established") {
                this.send({ type: "ping", id: randomUUID(), body: { timestamp: Date.now() } });
            }
        }, this.opts.pingIntervalMs);
    }

    private stopPing(): void {
        if (this.pingTimer !== null) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
    }

    private clearTimers(): void {
        if (this.helloTimer !== null) {
            clearTimeout(this.helloTimer);
            this.helloTimer = null;
        }
        this.stopPing();
        if (this.retryTimer !== null) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
        this.pendingHelloId = null;
    }

    /** 永久拒绝：关闭连接，不再重连，上报 onEnded。 */
    private reject(detail: string, code?: number): void {
        this.rejected = true;
        this.clearTimers();
        this.state = "stopped";
        const ws = this.ws;
        this.ws = null;
        ws?.close();
        const reason: ConnectionEndedReason = { permanent: true, detail };
        if (code !== undefined) {
            reason.code = code;
        }
        this.opts.onEnded(reason);
    }

    /** close：区分用户停止 / 永久拒绝（1002/1008）/ 可重连断开。 */
    private onClose(code: number, reason: string): void {
        if (this.helloTimer !== null) {
            clearTimeout(this.helloTimer);
            this.helloTimer = null;
        }
        this.stopPing();
        const wasEstablished = this.state === "established";
        this.ws = null;
        if (this.userStopped || this.rejected) {
            this.state = "stopped";
            return;
        }
        this.state = "idle";
        // 1002 协议错误（版本不匹配）/ 1008 策略违规（token 错）：等待版本升级/配置修正
        if (code === 1002 || code === 1008) {
            this.log.error({ code, reason }, "kurobot: 连接被拒（不可重试错误），停止重连");
            this.rejected = true;
            this.state = "stopped";
            this.opts.onEnded({ permanent: true, code, detail: reason || `closed ${code}` });
            return;
        }
        if (wasEstablished) {
            this.log.warn({ code, reason }, "kurobot: 连接断开，准备重连");
        }
        this.scheduleRetry();
    }

    /** 指数退避重连：base * 2^attempt 封顶 retryMaxDelayMs；established 成功清零。 */
    private scheduleRetry(): void {
        if (this.userStopped || this.rejected || this.retryTimer !== null) {
            return;
        }
        this.state = "backoff";
        const delay = Math.min(
            this.opts.retryBaseDelayMs * 2 ** this.attempt,
            this.opts.retryMaxDelayMs,
        );
        this.attempt += 1;
        this.log.debug({ delay, attempt: this.attempt }, "kurobot: 退避后重连");
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.connect();
        }, delay);
    }
}

/** 从已解析的原始帧 JSON 取 header.id（容忍缺失）。 */
function headerId(json: unknown): string | undefined {
    if (typeof json !== "object" || json === null) {
        return undefined;
    }
    const header = (json as { header?: unknown }).header;
    if (typeof header !== "object" || header === null) {
        return undefined;
    }
    const id = (header as { id?: unknown }).id;
    return typeof id === "string" ? id : undefined;
}

/** 静默日志（缺省）。 */
const SILENT_LOGGER: KurobotLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
};
