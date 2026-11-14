/**
 * OB11 传输装配
 *
 * 按 OB11Config 创建/装配 network 传输适配器：
 *  - HTTP 反向（http.enabled）：HttpServer 接收第三方调用 → handleRequest → 响应
 *  - WS 反向（ws.enabled）：WsServer 第三方连入 → handleRequest（echo 透传）+ 事件广播
 *  - HTTP 正向（httpPost.enabled）：HttpClient 事件上报（fire-and-forget）
 *  - WS 正向（wsReverse.enabled）：WsClient 主动连第三方（双向）
 *
 * 鉴权：token 存在时校验 Authorization: Bearer <token> / access_token 查询参数。
 * 返回 transports（事件上报用，注册到 broadcaster）与 close（停止时关闭全部）。
 */
import {
    type AuthorizeHook,
    type EventBroadcaster,
    HttpClient,
    HttpServer,
    type RequestContext,
    type TransportAdapter,
    WsClient,
    WsServer,
} from "@napuketto/network";
import type { OB11Config } from "./helper/index.js";

/** Authorization 头前缀。 */
const BEARER_PREFIX = "Bearer ";

/** 校验 URL 查询参数里的 access_token（WS client 连接 URL 可能带）。
 * ⚠️ req.url 是纯路径（无 origin），new URL(相对路径) 必抛——
 *  E2E 实测抓到的 bug（查询参数鉴权从未生效，WS 全被 4401 关闭），
 * 用 dummy base 解析。 */
function hasAccessTokenQuery(url: string, token: string): boolean {
    try {
        const parsed = new URL(url, "http://localhost");
        return parsed.searchParams.get("access_token") === token;
    } catch {
        return false;
    }
}

/** 校验 Authorization: Bearer <token> 头。 */
function checkBearer(auth: string | undefined, token: string): boolean {
    if (auth === undefined || !auth.startsWith(BEARER_PREFIX)) {
        return false;
    }
    return auth.slice(BEARER_PREFIX.length) === token;
}

/** 构造鉴权钩子（token 未配置则不鉴权）。 */
function makeAuthorize(token: string | undefined): AuthorizeHook | undefined {
    if (token === undefined || token === "") {
        return;
    }
    return (ctx: RequestContext): boolean => {
        const auth = ctx.headers["authorization"] ?? ctx.headers["Authorization"];
        if (checkBearer(auth, token) || ctx.headers["authorization"] === token) {
            return true;
        }
        return hasAccessTokenQuery(ctx.url, token);
    };
}

/** 传输装配结果。 */
export interface Ob11TransportSet {
    /** 反向 server（HTTP/WS，第三方调用入口）。 */
    servers: TransportAdapter[];
    /** 事件上报传输（正向 client，已注册到 broadcaster）。 */
    transports: TransportAdapter[];
    /** 停止：关闭全部传输（幂等）。 */
    close: () => Promise<void>;
}

/** 传输装配选项。 */
export interface AssembleOb11TransportsOptions {
    /** OB11 配置。 */
    config: OB11Config;
    /** 事件广播（正向上报传输注册到它）。 */
    broadcaster: EventBroadcaster;
    /** 请求分发（adapter.handleRequest，HTTP/WS 共用）。 */
    handleRequest: (req: unknown, respond: (res: unknown) => void) => void;
    /** 机器人自身 uin（koishi 等第三方按 X-Self-ID 识别连接归属）。 */
    selfUin: string;
}

/**
 * OneBot 客户端标识头：koishi 的 onebot 适配器按
 * x-client-role === "Universal" 与 x-self-id 校验 WS 连接（NapCat 同款头），
 * 缺失会被 close(1008) 拒绝——连接虽握手成功但应用层不认。
 */
function oneBotClientHeaders(selfUin: string): Record<string, string> {
    return {
        "X-Self-ID": selfUin,
        "x-client-role": "Universal",
        "User-Agent": "OneBot/11",
    };
}

/** 按配置装配 OB11 传输。 */
export function assembleOb11Transports(opts: AssembleOb11TransportsOptions): Ob11TransportSet {
    const { config, broadcaster, handleRequest, selfUin } = opts;
    const servers: TransportAdapter[] = [];
    const transports: TransportAdapter[] = [];

    assembleHttpServers(config, handleRequest, servers);
    assembleWsServers(config, handleRequest, servers);
    assembleHttpPosts(config, selfUin, transports);
    assembleWsReverses(config, selfUin, handleRequest, transports);

    // 注册事件上报传输（正向 client：HTTP 上报 / WS 正向）
    for (const t of transports) {
        broadcaster.register(t);
    }
    // 反向 server 也注册（修复）：反向 WS 客户端（koishi 等）连入后
    // 必须能收到事件广播（lifecycle/heartbeat/消息事件）。此前只注册正向传输，
    // 反向 WsServer 未注册 → 客户端连上后收不到任何事件（NapCat 语义：反向连接
    // 同样收广播）。HttpServer.send 为 no-op（HTTP 无推送），注册无害。
    for (const s of servers) {
        broadcaster.register(s);
    }

    return {
        servers,
        transports,
        close: async () => {
            await Promise.all([...servers, ...transports].map((t) => t.close()));
            for (const t of [...servers, ...transports]) {
                broadcaster.unregister(t);
            }
        },
    };
}

/** 装配 HTTP 反向 server 列表（每实例一个 HttpServer，共享 handleRequest）。 */
function assembleHttpServers(
    config: OB11Config,
    handleRequest: (req: unknown, respond: (res: unknown) => void) => void,
    servers: TransportAdapter[],
): void {
    for (const item of config.httpServers) {
        if (item.enabled) {
            const options: ConstructorParameters<typeof HttpServer>[0] = {
                host: item.host,
                port: item.port,
            };
            const authorize = makeAuthorize(item.token ?? config.token);
            if (authorize !== undefined) {
                options.authorize = authorize;
            }
            const server = new HttpServer(options);
            server.onRequest = handleRequest;
            servers.push(server);
        }
    }
}

/** 装配反向 WS server 列表（每实例一个 WsServer，心跳 ping + 鉴权）。 */
function assembleWsServers(
    config: OB11Config,
    handleRequest: (req: unknown, respond: (res: unknown) => void) => void,
    servers: TransportAdapter[],
): void {
    for (const item of config.wsServers) {
        if (item.enabled) {
            const options: ConstructorParameters<typeof WsServer>[0] = {
                host: item.host,
                port: item.port,
                heartbeat: { intervalMs: item.heartbeatInterval },
            };
            const authorize = makeAuthorize(item.token ?? config.token);
            if (authorize !== undefined) {
                options.authorize = authorize;
            }
            const server = new WsServer(options);
            server.onRequest = handleRequest;
            servers.push(server);
        }
    }
}

/** 装配 HTTP 正向上报 client 列表（fire-and-forget）。 */
function assembleHttpPosts(
    config: OB11Config,
    selfUin: string,
    transports: TransportAdapter[],
): void {
    for (const item of config.httpPostUrls) {
        if (item.enabled && item.url !== undefined) {
            // koishi HTTP 上报同样按 x-self-id 识别 bot（缺失返回 403）
            const headers = {
                "x-self-id": selfUin,
                ...(authorizeHeader(item.token ?? config.token) ?? {}),
            };
            const options: ConstructorParameters<typeof HttpClient>[0] = {
                url: item.url,
                headers,
            };
            if (item.timeoutMs !== undefined) {
                options.timeoutMs = item.timeoutMs;
            }
            transports.push(new HttpClient(options));
        }
    }
}

/** 装配正向 WS client 列表（双向，心跳 + 重连 + 证书选项）。 */
function assembleWsReverses(
    config: OB11Config,
    selfUin: string,
    handleRequest: (req: unknown, respond: (res: unknown) => void) => void,
    transports: TransportAdapter[],
): void {
    for (const item of config.wsReverseUrls) {
        if (item.enabled && item.url !== undefined) {
            // koishi 等第三方按 X-Self-ID / x-client-role 识别并校验连接（NapCat 同款头），
            // 与 authorization 合并后作为握手请求头
            const headers = {
                ...oneBotClientHeaders(selfUin),
                ...(authorizeHeader(item.token ?? config.token) ?? {}),
            };
            // 独立构造重连策略：maxAttempts 条件附加（exactOptionalPropertyTypes）
            const reconnect: { enabled: boolean; delayMs: number; maxAttempts?: number } = {
                enabled: true,
                delayMs: item.reconnectDelayMs,
            };
            if (item.maxReconnectAttempts !== undefined) {
                reconnect.maxAttempts = item.maxReconnectAttempts;
            }
            const options: ConstructorParameters<typeof WsClient>[0] = {
                url: item.url,
                headers,
                heartbeat: { intervalMs: item.heartbeatInterval },
                reconnect,
                rejectUnauthorized: item.rejectUnauthorized,
            };
            const client = new WsClient(options);
            client.onRequest = handleRequest;
            transports.push(client);
        }
    }
}

/** token → Authorization 头（client 上报/连接用）。 */
function authorizeHeader(token: string | undefined): Record<string, string> | undefined {
    if (token === undefined || token === "") {
        return;
    }
    return { authorization: `${BEARER_PREFIX}${token}` };
}
