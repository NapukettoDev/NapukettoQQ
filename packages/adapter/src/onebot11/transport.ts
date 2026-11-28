/**
 * OB11 传输装配
 *
 * 按 OB11Config 创建/装配 network 传输适配器：
 *  - HTTP 反向（http.enabled）：HttpServer 接收第三方调用 → handleRequest → 响应
 *  - WS 反向（ws.enabled）：WsServer 第三方连入 → handleRequest（echo 透传）+ 事件广播
 *  - HTTP 正向（httpPost.enabled）：HttpClient 事件上报（fire-and-forget）
 *  - WS 正向（wsReverse.enabled）：WsClient 主动连第三方（双向）
 *
 * 鉴权：token 存在时校验 Authorization: Bearer <token> / 裸 authorization 头 /
 * access_token 查询参数（方言开关由 core 鉴权原语参数化）。
 * 返回 transports（事件上报用，注册到 broadcaster）与 close（停止时关闭全部）。
 */
import {
    type EventBroadcaster,
    HttpClient,
    HttpServer,
    type TransportAdapter,
    WsClient,
    WsServer,
} from "@napuketto/network";
import { BEARER_PREFIX, createTokenAuthorize } from "../framework/index.js";
import type { AdapterLoggerLike } from "../internal/infra/log.js";
import type { OB11Config } from "./helper/index.js";

/** 正向 WS client 首连失败的后台重连参数（HTTP 上报无连接，不参与）。 */
export interface Ob11OutboundWsReconnect {
    /** 配置项序号，用于定位日志。 */
    index: number;
    /** 首次重连延迟（毫秒；后续按 2 倍指数退避）。 */
    delayMs: number;
    /** 最大重连次数（不含首连）；缺省无限。 */
    maxAttempts?: number | undefined;
}

/** 出向传输（事件上报 / 正向 WS），`open` 由适配器统一发起。 */
export interface Ob11OutboundTransport {
    transport: TransportAdapter;
    /** 正向 WS 的重连参数（首连失败后台重试）；HTTP 上报为 undefined。 */
    wsReconnect?: Ob11OutboundWsReconnect | undefined;
}

/** 传输装配结果。 */
export interface Ob11TransportSet {
    /** 反向 server（HTTP/WS，第三方调用入口）。 */
    servers: TransportAdapter[];
    /** 事件上报传输（正向 client，已注册到 broadcaster）。 */
    transports: TransportAdapter[];
    /**
     * 出向传输的启动清单（issue #144）：与 `transports` 同源，额外携带正向 WS
     * 首连失败所需的后台重连参数——适配器据此容错，不因对端未启动而中断装配。
     */
    outbound: Ob11OutboundTransport[];
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
    logger?: Pick<AdapterLoggerLike, "warn"> | undefined;
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
    const outbound: Ob11OutboundTransport[] = [];

    assembleHttpServers(config, handleRequest, servers);
    assembleWsServers(config, handleRequest, servers);
    assembleHttpPosts(opts, transports, outbound);
    assembleWsReverses(config, selfUin, handleRequest, transports, outbound);

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
        outbound,
        close: async () => {
            const adapters = [...servers, ...transports];
            for (const t of adapters) {
                broadcaster.unregister(t);
            }
            await Promise.all(adapters.map((t) => t.close()));
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
            const authorize = createTokenAuthorize(item.token ?? config.token, {
                allowQueryToken: true,
                allowRawHeader: true,
            });
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
            const authorize = createTokenAuthorize(item.token ?? config.token, {
                allowQueryToken: true,
                allowRawHeader: true,
            });
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
    { config, selfUin, logger }: AssembleOb11TransportsOptions,
    transports: TransportAdapter[],
    outbound: Ob11OutboundTransport[],
): void {
    for (const [index, item] of config.httpPostUrls.entries()) {
        if (item.enabled && item.url !== undefined) {
            // koishi HTTP 上报同样按 x-self-id 识别 bot（缺失返回 403）
            const headers = {
                "x-self-id": selfUin,
                ...(authorizeHeader(item.token ?? config.token) ?? {}),
            };
            const options: ConstructorParameters<typeof HttpClient>[0] = {
                url: item.url,
                headers,
                onError: () => {
                    logger?.warn(
                        { category: "webhook_delivery_failed", index },
                        "onebot11: webhook 推送失败",
                    );
                },
            };
            if (item.timeoutMs !== undefined) {
                options.timeoutMs = item.timeoutMs;
            }
            const client = new HttpClient(options);
            transports.push(client);
            outbound.push({ transport: client });
        }
    }
}

/** 装配正向 WS client 列表（双向，心跳 + 重连 + 证书选项）。 */
function assembleWsReverses(
    config: OB11Config,
    selfUin: string,
    handleRequest: (req: unknown, respond: (res: unknown) => void) => void,
    transports: TransportAdapter[],
    outbound: Ob11OutboundTransport[],
): void {
    for (const [index, item] of config.wsReverseUrls.entries()) {
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
            // 首连容错参数（issue #144）：对端未启动时 adapter 后台重试，不中断装配
            outbound.push({
                transport: client,
                wsReconnect: {
                    index,
                    delayMs: item.reconnectDelayMs,
                    ...(item.maxReconnectAttempts !== undefined
                        ? { maxAttempts: item.maxReconnectAttempts }
                        : {}),
                },
            });
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
