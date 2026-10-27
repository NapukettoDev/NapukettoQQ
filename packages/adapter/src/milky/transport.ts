/**
 * Milky 传输装配（单端口 HTTP：POST /api/:api + GET /event SSE + /event WS 升级
 * + WebHook 主动推送，docs/protocols/milky.md §4）
 *
 * - HTTP API：HttpServer onPathRequest 分发 → 动作注册表 → 规范响应信封
 *   （200 ok / 200 failed(-400/-403/自定) / 401 鉴权 / 404 API 不存在（空 body）/
 *   415 Content-Type）。
 * - /event：onRawRequest 承接 SSE（createSseResponse，event: milky_event）；
 *   onUpgrade 承接同端口 WS 升级（网络原语 2026-10-28 下沉 network）。
 * - WebHook：HttpClient（fire-and-forget POST，Authorization 头带 token）。
 *
 * 事件推送统一经 MilkyEventHub（注册到 EventBroadcaster，send → SSE/WS 客户端）。
 */
import type {
    AuthorizeHook,
    EventBroadcaster,
    HttpRouteContext,
    RequestContext,
    Respond,
    TransportAdapter,
} from "@napuketto/network";
import { createSseResponse, HttpClient, HttpServer } from "@napuketto/network";
import { WebSocket } from "ws";
import type { ActionRegistry } from "../core/index.js";
import type { MilkyAction } from "./action/base-action.js";
import type { MilkyConfig } from "./config.js";

/** /event 路径（规范固定）。 */
const EVENT_PATH = "/event";
/** /api/ 前缀 + 动作名（小写字母开头，小写/数字/下划线）。 */
const API_PATH_RE = /^\/api\/([a-z][a-z0-9_]*)$/;
/** Bearer 前缀。 */
const BEARER_PREFIX = "Bearer ";

/** 校准 logger 最小面（webhook 失败 / 配置异常提示；缺省静默）。 */
export interface MilkyLoggerLike {
    warn(obj: unknown, msg?: string): void;
    info(obj: unknown, msg?: string): void;
}

/** 传输装配结果。 */
export interface MilkyTransportSet {
    /** 已注册 broadcaster 的传输（HTTP server + webhook clients + 事件枢纽）。 */
    adapters: TransportAdapter[];
    /** 停止：关闭传输 + 注销广播（幂等）。 */
    close: () => Promise<void>;
}

/**
 * Milky 事件枢纽：SSE 客户端 + WS 客户端集合，send 即广播。
 * 传输适配器面（open/close no-op）只为注册 EventBroadcaster——生命周期随
 * HttpServer。WS 入帧忽略（规范：/event 为纯事件推送通道）。
 */
export class MilkyEventHub implements TransportAdapter {
    private readonly sseClients = new Set<SseClientHandle>();
    private readonly sockets = new Set<WebSocket>();

    /** 注册 SSE 客户端（返回退订函数）。 */
    addSse(handle: SseClientHandle): () => void {
        this.sseClients.add(handle);
        return () => {
            this.sseClients.delete(handle);
        };
    }

    /** 注册 WS 客户端（断开/出错自动移除；入帧忽略）。 */
    addSocket(socket: WebSocket): () => void {
        this.sockets.add(socket);
        const remove = (): void => {
            this.sockets.delete(socket);
        };
        socket.on("close", remove);
        socket.on("error", remove);
        return remove;
    }

    /** 当前连接数（SSE + WS，测试/观测用）。 */
    get connections(): number {
        return this.sseClients.size + this.sockets.size;
    }

    /** 广播事件（EventBroadcaster emit 入口）。 */
    send<T>(event: T): void {
        const json = JSON.stringify(event);
        for (const client of this.sseClients) {
            client.send(json, "milky_event");
        }
        for (const socket of this.sockets) {
            if (socket.readyState === WebSocket.OPEN) {
                socket.send(json);
            }
        }
    }

    open(): void {
        // 生命周期随 HttpServer
    }

    async close(): Promise<void> {
        for (const client of this.sseClients) {
            client.close();
        }
        this.sseClients.clear();
        for (const socket of this.sockets) {
            socket.close(1001, "server shutdown");
        }
        this.sockets.clear();
    }

    onRequest?: (req: unknown, respond: Respond) => void;
}

/** SSE 客户端句柄（network SseClient + 显式关闭）。 */
export interface SseClientHandle {
    send(data: string, event?: string): void;
    close(): void;
}

/** 按配置装配 Milky 传输。 */
export function assembleMilkyTransports(opts: {
    config: MilkyConfig;
    broadcaster: EventBroadcaster;
    registry: ActionRegistry<MilkyAction<unknown, unknown>>;
    hub: MilkyEventHub;
    logger?: MilkyLoggerLike;
}): MilkyTransportSet {
    const { config, broadcaster, registry, hub, logger } = opts;
    const token = config.token;
    const authorize = token !== "" ? makeMilkyAuthorize(token) : undefined;

    const server = new HttpServer({
        host: config.host,
        port: config.port,
        ...(authorize !== undefined ? { authorize } : {}),
    });
    server.onRawRequest = (ctx, _req) => {
        if (ctx.path !== EVENT_PATH || ctx.method !== "GET") {
            return undefined;
        }
        if (!config.eventModes.includes("sse")) {
            return new Response("event mode sse disabled", { status: 404 });
        }
        return createSseResponse((client) => hub.addSse(client));
    };
    server.onUpgrade = (req, accept, reject) => {
        if (pathnameOf(req.url) !== EVENT_PATH) {
            return;
        }
        if (!config.eventModes.includes("ws")) {
            reject(404, "event mode ws disabled");
            return;
        }
        if (token !== "" && !tokenMatches(req, token)) {
            reject(401, "unauthorized");
            return;
        }
        accept((socket) => {
            hub.addSocket(socket);
        });
    };
    server.onPathRequest = (ctx, req, respond) => {
        handleMilkyHttpRequest(ctx, req, respond, registry);
    };

    const adapters: TransportAdapter[] = [server, hub];
    for (const url of config.webhooks) {
        const client = new HttpClient({
            url,
            ...(token !== "" ? { headers: { authorization: `${BEARER_PREFIX}${token}` } } : {}),
            timeoutMs: 5000,
            onError: (err: unknown) => {
                logger?.warn({ url, err: String(err) }, "milky: webhook 推送失败");
            },
        });
        adapters.push(client);
    }

    for (const adapter of adapters) {
        broadcaster.register(adapter);
    }
    return {
        adapters,
        close: async () => {
            await server.close();
            await hub.close();
            for (const adapter of adapters) {
                broadcaster.unregister(adapter);
            }
        },
    };
}

/** HTTP /api 分发（规范信封 + 404/415 语义）。 */
function handleMilkyHttpRequest(
    ctx: HttpRouteContext,
    req: unknown,
    respond: Respond,
    registry: ActionRegistry<MilkyAction<unknown, unknown>>,
): void {
    if (ctx.method !== "POST") {
        respond(undefined, 404);
        return;
    }
    const match = API_PATH_RE.exec(ctx.path);
    if (match === null) {
        respond(undefined, 404);
        return;
    }
    const contentType = ctx.headers?.["content-type"];
    if (contentType !== undefined && !contentType.toLowerCase().includes("application/json")) {
        respond(undefined, 415);
        return;
    }
    const action = registry.get(match[1] ?? "");
    if (action === undefined) {
        // API 不存在：HTTP 404 + 空 body（规范）
        respond(undefined, 404);
        return;
    }
    action
        .handle(req)
        .then((result) => {
            if (result.status === "ok") {
                respond({ status: "ok", retcode: 0, data: result.data ?? {} });
            } else {
                respond({
                    status: "failed",
                    retcode: result.retcode,
                    data: null,
                    message: result.message,
                });
            }
        })
        .catch(() => {
            respond({ status: "failed", retcode: -500, data: null, message: "internal error" });
        });
}

/** 鉴权钩子：Bearer 头或 access_token 查询参数（规范允许 SSE/WS 查询参数兜底）。 */
function makeMilkyAuthorize(token: string): AuthorizeHook {
    return (ctx) => tokenMatches(ctx, token);
}

/** 请求凭据匹配（头优先，查询参数兜底）。 */
function tokenMatches(ctx: RequestContext, token: string): boolean {
    const auth = ctx.headers["authorization"] ?? ctx.headers["Authorization"];
    if (auth?.startsWith(BEARER_PREFIX)) {
        return auth.slice(BEARER_PREFIX.length) === token;
    }
    try {
        const url = new URL(ctx.url, "http://localhost");
        return url.searchParams.get("access_token") === token;
    } catch {
        return false;
    }
}

/** URL 路径部分（无 scheme 相对 url 容错）。 */
function pathnameOf(url: string): string {
    try {
        return new URL(url, "http://localhost").pathname;
    } catch {
        return url.split("?")[0] ?? "";
    }
}
