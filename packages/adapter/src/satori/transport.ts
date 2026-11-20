/**
 * Satori 传输装配（HTTP RPC + WS 事件服务）
 *
 * - HTTP RPC：HttpServer 的 onPathRequest（network 协议无关扩展）按
 *   `/v1/{resource}.{method}` 分发 → 动作注册表 → 响应（错误用 HTTP 状态码）。
 * - WS 事件服务：WsServer（path=/v1/events）处理信令：
 *   IDENTIFY → READY（token 校验）；PING → PONG；EVENT 经 broadcaster 推送，
 *   且**只推给已完成 IDENTIFY 的连接**（见 SatoriEventHub）。
 *
 * 错误语义（规范）：标准 API 平台不支持 → 404；平台支持但未实现 → 501；
 * 非标准 API → 404；鉴权失败 → 401。
 */
import { isRecord } from "@napuketto/kernel";
import type {
    EventBroadcaster,
    HttpRouteContext,
    Respond,
    TransportAdapter,
    WsSocket,
} from "@napuketto/network";
import { HttpServer, isWsOpen, WsServer } from "@napuketto/network";
import { tokenEquals } from "../framework/auth.js";
import { createTokenAuthorize } from "../framework/index.js";
import { SatoriActionError, type SatoriActionRegistry } from "./action/index.js";
import { HTTP_STATUS, type SatoriConfig } from "./helper/index.js";
import { type Event, type Login, Opcode } from "./types/index.js";

/** WS 事件服务路径（规范固定）。 */
const WS_EVENTS_PATH = "/v1/events";
/** HTTP RPC 版本前缀。 */
const V1_PREFIX = "/v1/";

/**
 * IDENTIFY 鉴权超时（毫秒）：Satori 规范要求连接建立后 10s 内发送 IDENTIFY，
 * 超时未鉴权的连接不得继续持有（否则可长期挂在广播集合外白占资源）。
 */
const DEFAULT_IDENTIFY_TIMEOUT_MS = 10_000;

/**
 * 鉴权失败关闭码：4004 = authentication failed（Satori SDK 生态惯例）。
 * 与 OB11 的 4401 区分，避免 SDK 把「未认证」误判成通用「拒绝」。
 */
const WS_CLOSE_CODE_UNAUTHORIZED = 4004;

/** resource.method 路径模式（resource 与 method 均为字母开头的小写标识符，可含连字符/数字）。 */
const ACTION_PATH_RE = /^([a-z][a-z0-9-]*)(?:\.[a-z][a-z0-9-]*)+$/i;

/** 传输装配结果。 */
export interface SatoriTransportSet {
    /** 传输适配器（HTTP RPC + WS 事件枢纽，均已注册 broadcaster）。 */
    adapters: TransportAdapter[];
    /** 停止：关闭全部传输（幂等）。 */
    close: () => Promise<void>;
}

/** 传输装配选项。 */
export interface AssembleSatoriTransportsOptions {
    /** Satori 配置。 */
    config: SatoriConfig;
    /** 事件广播（WS 事件服务注册到它，EVENT 信令经 broadcastEvent 推送）。 */
    broadcaster: EventBroadcaster;
    /** 动作注册表（HTTP RPC 分发用）。 */
    registry: SatoriActionRegistry;
    /** 登录信息构造（READY logins / meta 用）。 */
    login: () => Login;
    /** WS 未鉴权连接的 IDENTIFY 超时（毫秒）；缺省 10s（规范值），主要供测试收敛。 */
    identifyTimeoutMs?: number | undefined;
}

/**
 * Satori 事件枢纽：只向「已完成 IDENTIFY 鉴权」的连接广播 EVENT 信令。
 *
 * 为什么需要它：Satori 采用连接建立后的带内鉴权（`IDENTIFY.body.token`），握手
 * 阶段没有凭据，不能复用 `WsServer.authorize`；而 `WsServer.send` 会向全部 OPEN
 * 连接广播——直接把 WsServer 注册进 EventBroadcaster，等于把该账号的全部消息
 * 推给任何未认证的 WS 客户端。本类接管 wsServers 的 send/open/close：
 *
 * - 未认证连接收不到任何 EVENT；
 * - `IDENTIFY` token 不符 → 立即 4004 关闭，而不是「不响应、挂着」；
 * - 连接建立后 `identifyTimeoutMs` 内未完成 IDENTIFY → 4004 关闭；
 * - token 为空（未配置鉴权）时连接建立即视为已认证，保持「空 token = 不鉴权」。
 */
class SatoriEventHub implements TransportAdapter {
    private readonly server: WsServer;
    private readonly token: string | undefined;
    private readonly login: () => Login;
    private readonly identifyTimeoutMs: number;
    /** 已完成 IDENTIFY（或未配置 token）的连接：唯一的 EVENT 接收者。 */
    private readonly authenticated = new Set<WsSocket>();
    /** 已连接但尚未完成 IDENTIFY 的连接 → 认证超时计时器。 */
    private readonly pendingAuth = new Map<WsSocket, NodeJS.Timeout>();

    constructor(
        server: WsServer,
        token: string | undefined,
        login: () => Login,
        identifyTimeoutMs: number,
    ) {
        this.server = server;
        this.token = token;
        this.login = login;
        this.identifyTimeoutMs = identifyTimeoutMs;
    }

    /** 把连接生命周期与信令分发挂到 WsServer（装配时调用一次）。 */
    attach(): void {
        this.server.onConnection = (socket) => {
            this.track(socket);
        };
        this.server.onRequest = (signal, respond, socket) => {
            this.handleSignal(signal, respond, socket);
        };
    }

    /** 广播 EVENT 信令（只发给已认证连接）。 */
    send<T>(payload: T): void {
        if (this.authenticated.size === 0) {
            return;
        }
        const data = JSON.stringify(payload);
        for (const socket of this.authenticated) {
            if (isWsOpen(socket)) {
                socket.send(data);
            }
        }
    }

    /** 生命周期随 WsServer。 */
    async open(): Promise<void> {
        await this.server.open();
    }

    /** 关闭：先断开全部连接（含待认证），再关 server（server.close 等待连接释放）。 */
    async close(): Promise<void> {
        for (const timer of this.pendingAuth.values()) {
            clearTimeout(timer);
        }
        this.pendingAuth.clear();
        for (const socket of this.authenticated) {
            socket.close(1001, "server shutdown");
        }
        this.authenticated.clear();
        await this.server.close();
    }

    /** 是否配置了 token（空串 / undefined = 不鉴权）。 */
    private requiresAuth(): boolean {
        return this.token !== undefined && this.token !== "";
    }

    /** 登记新连接：无 token 直接认证，否则启动 IDENTIFY 超时。 */
    private track(socket: WsSocket): void {
        const forget = (): void => {
            this.clearPending(socket);
            this.authenticated.delete(socket);
        };
        socket.on("close", forget);
        socket.on("error", forget);
        if (!this.requiresAuth()) {
            this.authenticated.add(socket);
            return;
        }
        const timer = setTimeout(() => {
            this.reject(socket, "IDENTIFY timeout");
        }, this.identifyTimeoutMs);
        // 待认证连接不阻塞进程自然退出
        timer.unref?.();
        this.pendingAuth.set(socket, timer);
    }

    /** 清除连接的认证超时（幂等）。 */
    private clearPending(socket: WsSocket): void {
        const timer = this.pendingAuth.get(socket);
        if (timer !== undefined) {
            clearTimeout(timer);
            this.pendingAuth.delete(socket);
        }
    }

    /** 拒绝连接：清认证状态并以 4004 关闭（已关闭的连接不重复关）。 */
    private reject(socket: WsSocket, reason: string): void {
        this.clearPending(socket);
        this.authenticated.delete(socket);
        if (isWsOpen(socket)) {
            socket.close(WS_CLOSE_CODE_UNAUTHORIZED, reason);
        }
    }

    /** 信令处理：IDENTIFY（token 校验 → 加入认证集合）/ PING。 */
    private handleSignal(signal: unknown, respond: Respond, socket: WsSocket): void {
        if (!isRecord(signal)) {
            return;
        }
        const op = signal["op"];
        if (op === Opcode.IDENTIFY) {
            if (this.requiresAuth()) {
                const body = isRecord(signal["body"]) ? signal["body"] : {};
                if (!tokenEquals(body["token"], this.token)) {
                    this.reject(socket, "unauthorized");
                    return;
                }
            }
            this.clearPending(socket);
            this.authenticated.add(socket);
            // 会话恢复（body.sn）：第一版跳过，直接 READY 当前状态
            respond({
                op: Opcode.READY,
                body: { logins: [this.login()], proxy_urls: [] },
            });
            return;
        }
        if (op === Opcode.PING) {
            respond({ op: Opcode.PONG, body: null });
        }
        // 其他信令忽略（EVENT/META 为 SDK 侧接收）
    }
}

/** 按配置装配 Satori 传输。 */
export function assembleSatoriTransports(
    opts: AssembleSatoriTransportsOptions,
): SatoriTransportSet {
    const { config, broadcaster, registry, login } = opts;
    const identifyTimeoutMs = opts.identifyTimeoutMs ?? DEFAULT_IDENTIFY_TIMEOUT_MS;
    const adapters: TransportAdapter[] = [];

    for (const item of config.httpServers) {
        if (!item.enabled) {
            continue;
        }
        const token = item.token ?? config.token;
        const authorize = createTokenAuthorize(token);
        const server = new HttpServer({
            host: item.host,
            port: item.port,
            ...(authorize !== undefined ? { authorize } : {}),
        });
        server.onPathRequest = (ctx, req, respond) => {
            handleHttpRequest(ctx, req, respond, registry, login);
        };
        adapters.push(server);
    }

    for (const item of config.wsServers) {
        if (!item.enabled) {
            continue;
        }
        const token = item.token ?? config.token;
        const server = new WsServer({
            host: item.host,
            port: item.port,
            path: WS_EVENTS_PATH,
        });
        const hub = new SatoriEventHub(server, token, login, identifyTimeoutMs);
        hub.attach();
        adapters.push(hub);
    }

    // 注册事件广播（HTTP server 的 send 为 no-op，注册无害；WS 事件枢纽只推已认证连接）
    for (const adapter of adapters) {
        broadcaster.register(adapter);
    }

    return {
        adapters,
        close: async () => {
            await Promise.all(adapters.map((a) => a.close()));
            for (const adapter of adapters) {
                broadcaster.unregister(adapter);
            }
        },
    };
}

/** 解析路径：/v1/{resource}.{method} → 动作名；不匹配返回 null。 */
function parseActionPath(path: string): string | null {
    if (!path.startsWith(V1_PREFIX)) {
        return null;
    }
    const rest = path.slice(V1_PREFIX.length);
    const m = ACTION_PATH_RE.exec(rest);
    if (m === null) {
        return null;
    }
    return rest;
}

/** HTTP RPC 分发。 */
function handleHttpRequest(
    ctx: HttpRouteContext,
    req: unknown,
    respond: Respond,
    registry: SatoriActionRegistry,
    login: () => Login,
): void {
    if (ctx.method !== "POST") {
        respond({ error: "method not allowed" }, 405);
        return;
    }
    const action = parseActionPath(ctx.path);
    if (action === null) {
        respond({ error: "api not found" }, HTTP_STATUS.notFound);
        return;
    }
    // 元信息（无需平台头）
    if (action === "meta") {
        respond({ logins: [login()], proxy_urls: [] }, HTTP_STATUS.ok);
        return;
    }
    const act = registry.get(action);
    if (act === undefined) {
        respond({ error: "api not found" }, HTTP_STATUS.notFound);
        return;
    }
    act.run(req)
        .then((data) => {
            respond(data ?? {}, HTTP_STATUS.ok);
        })
        .catch((err: unknown) => {
            if (err instanceof SatoriActionError) {
                respond({ error: err.message }, err.status);
                return;
            }
            respond(
                { error: err instanceof Error ? err.message : "internal error" },
                HTTP_STATUS.serverError,
            );
        });
}

/** 事件信令（adapter 广播用）。 */
export function toEventSignal(event: Event): { op: number; body: Event } {
    return { op: Opcode.EVENT, body: event };
}
