/**
 * @napuketto/network 核心接口（ADR-002）
 *
 * 协议无关的传输原语：HTTP server/client、WS server/client、泛型广播总线、
 * SSE 事件流原语。不 import 任何协议包；事件类型完全泛型化。
 * 路由分发外置为 `onRequest` 注入点，由调用方提供。
 */
import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";

/**
 * 请求上下文：供鉴权钩子使用的原始请求信息。
 * headers 值可能为 undefined（如 WS 握手头缺失时）。
 */
export interface RequestContext {
    url: string;
    headers: Record<string, string | undefined>;
}

/**
 * Node 原生 IncomingMessage → RequestContext（headers 展平，url 含查询串）。
 * HTTP upgrade 与反向 WS 握手共用同一转换口径。
 */
export function incomingMessageToRequestContext(req: IncomingMessage): RequestContext {
    const headers: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(req.headers)) {
        headers[key] = Array.isArray(value) ? value.join(", ") : value;
    }
    return { url: req.url ?? "", headers };
}

/** 鉴权钩子：由协议层决定具体校验规则（token 等）。 */
export type AuthorizeHook = (ctx: RequestContext) => boolean;

/**
 * WS 连接（ws 实现类型）。
 *
 * 协议层只经这个别名接触连接：ws 的类型与实例都由 network 拥有，adapter 不需要
 * 在自己的 `dependencies` 里再声明 ws（2026-11-03 依赖收敛）。
 */
export type WsSocket = WebSocket;

/** ws READY_STATE.OPEN（规范固定值 1；协议层不出现魔法数字、也不依赖 ws 常量）。 */
const WS_READY_STATE_OPEN = 1;

/** 连接是否可发送（协议层判 readyState 的唯一入口）。 */
export function isWsOpen(socket: WsSocket): boolean {
    return socket.readyState === WS_READY_STATE_OPEN;
}

/**
 * 响应回调：协议层处理后回发。
 * `status` 为可选 HTTP 状态码（HTTP server 用；WS 传输忽略）。
 */
export type Respond = (res: unknown, status?: number) => void;

/**
 * 传输适配器：协议无关。
 * - `send`：协议无关推送（HTTP 反向无主动推送，实现为 no-op）
 * - `onRequest`：接收第三方请求 → 协议层处理后经 `respond` 回发；
 *   第三参为发起请求的连接（仅 WS 类传输提供，HTTP 类实现可忽略）
 */
export interface TransportAdapter {
    send: <T>(payload: T) => void;
    open: () => void | Promise<void>;
    close: () => void | Promise<void>;
    onRequest?: (req: unknown, respond: Respond, socket: WsSocket) => void;
}

/**
 * HTTP 路由上下文，`path` 为请求路径，`method` 为 HTTP 方法；
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
 * 同端口 WS 升级注入点。
 * 同步选择 accept 或 reject，只采纳第一次调用并在钩子返回后执行。
 * 未选择回 404，钩子抛错回 500，拒绝时写完 HTTP 响应并关闭连接。
 * accept 完成握手后交付 WS 连接，交接回调抛错时终止该连接。
 * 升级鉴权由协议层在钩子内判定。
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
    path?: string | undefined;
    /** 鉴权钩子；缺省不鉴权。 */
    authorize?: AuthorizeHook | undefined;
}

/**
 * HTTP 请求体缺省上限（字节，16 MiB），可容纳常见内联媒体，同时限制解析开销。
 */
export const DEFAULT_MAX_BODY_BYTES: number = 16 * 1024 * 1024;

/**
 * 单条 WS 消息缺省上限（字节，32 MiB）。
 *
 * 从 ws 的缺省 100 MiB 收紧，仍可容纳约 24 MB 的 base64 编码前媒体。
 */
export const DEFAULT_MAX_PAYLOAD_BYTES: number = 32 * 1024 * 1024;

/** 反向 HTTP server 选项。 */
export interface HttpServerOptions extends ServerOptions {
    /** 等待普通 JSON 请求 respond 的超时（毫秒），超时回 504；非正数/缺省不启用，不适用于原始流式响应。 */
    timeoutMs?: number | undefined;
    /** 请求体上限（字节）；缺省 DEFAULT_MAX_BODY_BYTES。 */
    bodyLimitBytes?: number | undefined;
    /** 同端口 WS 升级的单消息上限（字节）；缺省 DEFAULT_MAX_PAYLOAD_BYTES。 */
    wsMaxPayloadBytes?: number | undefined;
}

/** 正向 HTTP 客户端（事件上报）选项。 */
export interface HttpClientOptions {
    /** 上报地址（完整 URL）。 */
    url: string;
    headers?: Record<string, string> | undefined;
    /** 从提交到投递完成的期限（毫秒）；缺省 5 秒。 */
    timeoutMs?: number | undefined;
    /** 上报失败回调，含队列拒收和超时。 */
    onError?: ((err: unknown) => void) | undefined;
}

export interface WsHeartbeatOptions {
    /** 连接建立或收到匹配 pong 后，到下一次 ping 的间隔。 */
    intervalMs: number;
    /** 等待匹配 pong 的时限；缺省取 max(intervalMs, 1000) 毫秒。 */
    pongTimeoutMs?: number | undefined;
}

/** 反向 WS server 选项。 */
export interface WsServerOptions extends ServerOptions {
    /** ping/pong 判活，缺省不探测。 */
    heartbeat?: WsHeartbeatOptions | undefined;
    /** 单条消息上限（字节）；缺省 DEFAULT_MAX_PAYLOAD_BYTES。 */
    maxPayloadBytes?: number | undefined;
    /** 每条连接的发送缓冲上限（字节，含待发送帧）；缺省 32 MiB。 */
    maxBufferedBytes?: number | undefined;
}

/** 正向 WS 客户端（主动连接 / 反向连接）选项。 */
export interface WsClientOptions {
    /** 服务端地址（完整 URL，含 ws:// 或 wss://）。 */
    url: string;
    headers?: Record<string, string> | undefined;
    /** 入站单条消息上限（字节）；缺省 DEFAULT_MAX_PAYLOAD_BYTES。 */
    maxPayloadBytes?: number | undefined;
    /** ping/pong 判活，缺省不探测。 */
    heartbeat?: WsHeartbeatOptions | undefined;
    /** 发送缓冲上限（字节，含待发送帧）；缺省 32 MiB。 */
    maxBufferedBytes?: number | undefined;
    /** 断线重连策略，缺省不重连。 */
    reconnect?:
        | {
              enabled: boolean;
              /** 首次重连的等待时间，也是后续指数退避的基准（毫秒）。 */
              delayMs: number;
              /** 最大延迟（毫秒）；缺省 30 秒，至少容纳 delayMs。 */
              maxDelayMs?: number | undefined;
              /** 第二次起的向下抖动比例（0–1）；缺省 0.2，0 禁用。 */
              jitterRatio?: number | undefined;
              /** 最大重连次数；缺省无限。 */
              maxAttempts?: number | undefined;
          }
        | undefined;
    /** wss:// 是否校验证书链（缺省使用 Node 严格校验；自签证书场景可设 false）。 */
    rejectUnauthorized?: boolean | undefined;
}
