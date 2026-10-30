/**
 * @napuketto/network 核心接口（ADR-002）
 *
 * 协议无关的传输原语：HTTP server/client、WS server/client、泛型广播总线、
 * SSE 事件流原语。不 import 任何协议包；事件类型完全泛型化。
 * 路由分发外置为 `onRequest` 注入点，由协议层（onebot 等）提供。
 */
import type { WebSocket } from "ws";

/**
 * 请求上下文：供鉴权钩子使用的原始请求信息。
 * headers 值可能为 undefined（如 WS 握手头缺失时）。
 */
export interface RequestContext {
    url: string;
    headers: Record<string, string | undefined>;
}

/** 鉴权钩子：由协议层决定具体校验规则（token 等）。 */
export type AuthorizeHook = (ctx: RequestContext) => boolean;

/**
 * 响应回调：协议层处理后回发。
 * `status` 为可选 HTTP 状态码（HTTP server 用；WS 传输忽略）。
 * OB11 不传 status（恒 200）；Satori RPC 用 status 表达 404/501 等。
 */
export type Respond = (res: unknown, status?: number) => void;

/**
 * 传输适配器：协议无关（对应 NapCat OB11NetworkAdapter 的泛型化）。
 * - `send`：协议无关推送（HTTP 反向无主动推送，实现为 no-op）
 * - `onRequest`：接收第三方请求 → 协议层处理后经 `respond` 回发
 */
export interface TransportAdapter {
    send: <T>(payload: T) => void;
    open: () => void | Promise<void>;
    close: () => void | Promise<void>;
    onRequest?: (req: unknown, respond: Respond) => void;
}

/**
 * HTTP 路由上下文（协议无关，Satori RPC 等按路径分发的协议用）。
 * `path` 为请求路径（如 /v1/message.create），`method` 为 HTTP 方法；
 * `headers` 供协议层做 Content-Type 等检查（onPathRequest 场景）。
 */
export interface HttpRouteContext {
    path: string;
    method: string;
    headers?: Record<string, string | undefined>;
}

/**
 * 流式/原始响应注入点（协议无关，SSE 等无 JSON body 的端点用）。
 * 返回 Response 即短路（跳过 JSON 解析与常规分发）；返回 undefined 继续
 * 常规流程（JSON 解析 → onPathRequest/onRequest）。同步判定，不做异步。
 */
export type RawRequestHook = (ctx: HttpRouteContext, req: RequestContext) => Response | undefined;

/**
 * 同端口 WS 升级注入点（协议无关，Milky /event 等用）。
 * accept 把升级后的 WS 连接交协议层收发；reject 以 HTTP 状态码拒绝（socket 直毁）。
 * 升级请求不走 authorize 钩子（升级握手无标准响应通道），鉴权由协议层在
 * 钩子内按 ctx 自行判定（token 头或 access_token 查询参数）。
 */
export type WsUpgradeHook = (
    req: RequestContext,
    accept: (onSocket: (socket: WebSocket) => void) => void,
    reject: (status: number, reason?: string) => void,
) => void;

/** 服务器公共选项。 */
export interface ServerOptions {
    host: string;
    port: number;
    /** 监听路径；缺省监听全部路径。 */
    path?: string;
    /** 鉴权钩子；缺省不鉴权。 */
    authorize?: AuthorizeHook;
}

/** 反向 HTTP server 选项。 */
export interface HttpServerOptions extends ServerOptions {
    /** 处理超时（毫秒）；缺省不超时。 */
    timeoutMs?: number;
}

/** 正向 HTTP 客户端（事件上报）选项。 */
export interface HttpClientOptions {
    /** 上报地址（完整 URL）。 */
    url: string;
    headers?: Record<string, string>;
    /** 请求超时（毫秒）；缺省不超时。 */
    timeoutMs?: number;
    /** 上报失败回调（网络错误 / 非 2xx / 超时）。 */
    onError?: (err: unknown) => void;
}

/** 反向 WS server 选项。 */
export interface WsServerOptions extends ServerOptions {
    /** 心跳：按间隔向所有客户端 ping。缺省不心跳。 */
    heartbeat?: { intervalMs: number };
}

/** 正向 WS 客户端（主动连接 / 反向连接）选项。 */
export interface WsClientOptions {
    /** 服务端地址（完整 URL，含 ws:// 或 wss://）。 */
    url: string;
    headers?: Record<string, string>;
    /** 心跳：按间隔 ping，缺省不心跳。 */
    heartbeat?: { intervalMs: number };
    /** 断线重连策略，缺省不重连。 */
    reconnect?: {
        enabled: boolean;
        /** 重连延迟（毫秒）。 */
        delayMs: number;
        /** 最大重连次数；缺省无限。 */
        maxAttempts?: number;
    };
    /** wss:// 是否校验证书链（缺省 undefined = Node 默认严格校验；自签证书场景设 false，对齐 NapCat enableSelfSigned）。 */
    rejectUnauthorized?: boolean;
}
