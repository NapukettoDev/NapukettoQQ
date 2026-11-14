/**
 * Satori 传输装配（HTTP RPC + WS 事件服务）
 *
 * - HTTP RPC：HttpServer 的 onPathRequest（network 协议无关扩展）按
 *   `/v1/{resource}.{method}` 分发 → 动作注册表 → 响应（错误用 HTTP 状态码）。
 * - WS 事件服务：WsServer（path=/v1/events）处理信令：
 *   IDENTIFY → READY（token 校验）；PING → PONG；EVENT 经 broadcaster 推送。
 *
 * 错误语义（规范）：标准 API 平台不支持 → 404；平台支持但未实现 → 501；
 * 非标准 API → 404；鉴权失败 → 401。
 */
import type {
    AuthorizeHook,
    EventBroadcaster,
    HttpRouteContext,
    Respond,
    TransportAdapter,
} from "@napuketto/network";
import { HttpServer, WsServer } from "@napuketto/network";
import { SatoriActionError } from "./action/base-action.js";
import type { SatoriActionRegistry } from "./action/index.js";
import { HTTP_STATUS, type SatoriConfig } from "./helper/index.js";
import { type Event, type IdentifyBody, type Login, Opcode } from "./types/index.js";

/** WS 事件服务路径（规范固定）。 */
const WS_EVENTS_PATH = "/v1/events";
/** HTTP RPC 版本前缀。 */
const V1_PREFIX = "/v1/";

/** Authorization 头前缀。 */
const BEARER_PREFIX = "Bearer ";

/** resource.method 路径模式（resource 与 method 均为字母开头的小写标识符，可含连字符/数字）。 */
const ACTION_PATH_RE = /^([a-z][a-z0-9-]*)(?:\.[a-z][a-z0-9-]*)+$/i;

/** 传输装配结果。 */
export interface SatoriTransportSet {
    /** 传输适配器（HTTP RPC + WS 事件服务，均已注册 broadcaster）。 */
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
}

/** 按配置装配 Satori 传输。 */
export function assembleSatoriTransports(
    opts: AssembleSatoriTransportsOptions,
): SatoriTransportSet {
    const { config, broadcaster, registry, login } = opts;
    const adapters: TransportAdapter[] = [];

    for (const item of config.httpServers) {
        if (!item.enabled) {
            continue;
        }
        const token = item.token ?? config.token;
        const server = new HttpServer({
            host: item.host,
            port: item.port,
            ...(token !== undefined && token !== ""
                ? { authorize: makeBearerAuthorize(token) }
                : {}),
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
        server.onRequest = (req, respond) => {
            handleWsSignal(req, respond, token, login);
        };
        adapters.push(server);
    }

    // 注册事件广播（HTTP server 的 send 为 no-op，注册无害；WS 事件服务接收 EVENT 信令）
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

/** Bearer token 鉴权钩子。 */
function makeBearerAuthorize(token: string): AuthorizeHook {
    return (ctx) => {
        const auth = ctx.headers["authorization"] ?? ctx.headers["Authorization"];
        if (auth?.startsWith(BEARER_PREFIX)) {
            return auth.slice(BEARER_PREFIX.length) === token;
        }
        return false;
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

/** WS 信令处理（IDENTIFY → READY；PING → PONG）。 */
function handleWsSignal(
    signal: unknown,
    respond: Respond,
    token: string | undefined,
    login: () => Login,
): void {
    const parsed = (signal ?? {}) as { op?: unknown; body?: unknown };
    const op = parsed.op;
    if (op === Opcode.IDENTIFY) {
        const body = (parsed.body ?? {}) as Partial<IdentifyBody>;
        // 鉴权：配置了 token 时校验 IDENTIFY token；失败不响应（客户端超时断开）
        if (token !== undefined && token !== "" && body.token !== token) {
            return;
        }
        // 会话恢复（body.sn）：第一版跳过，直接 READY 当前状态
        respond({
            op: Opcode.READY,
            body: { logins: [login()], proxy_urls: [] },
        });
        return;
    }
    if (op === Opcode.PING) {
        respond({ op: Opcode.PONG, body: null });
    }
    // 其他信令忽略（EVENT/META 为 SDK 侧接收）
}

/** 事件信令（adapter 广播用）。 */
export function toEventSignal(event: Event): { op: number; body: Event } {
    return { op: Opcode.EVENT, body: event };
}
