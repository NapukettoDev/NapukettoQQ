/**
 * 反向 HTTP server（hono + @hono/node-server）
 *
 * 接收第三方调用：POST JSON → `onRequest` 注入点（协议层分发）→ 响应回发。
 * 鉴权（token）通过 `authorize` 钩子，规则由协议层决定。
 */

import { createServer, type Server, STATUS_CODES } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { types } from "node:util";
import { getRequestListener, RequestError } from "@hono/node-server";
import type { Context } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { WebSocketServer } from "ws";
import {
    DEFAULT_MAX_BODY_BYTES,
    DEFAULT_MAX_PAYLOAD_BYTES,
    type HttpRouteContext,
    type HttpServerOptions,
    incomingMessageToRequestContext,
    type RequestContext,
    type Respond,
    type TransportAdapter,
    type WsSocket,
    type WsUpgradeHook,
} from "./types.js";

const HTTP_STATUS = {
    badRequest: 400,
    unauthorized: 401,
    notFound: 404,
    payloadTooLarge: 413,
    internalError: 500,
    unavailable: 503,
    timeout: 504,
} as const;

/** 关闭握手宽限期；之后强断所有剩余 TCP 连接，包括升级后的 WS。 */
const CLOSE_GRACE_MS = 250;
const STATUS_REASON = /^[ -~]{1,128}$/;

type UpgradeDecision =
    | { accept: (socket: WsSocket) => void }
    | { status: number; reason?: string | undefined };

function decideUpgrade(hook: WsUpgradeHook | undefined, req: RequestContext): UpgradeDecision {
    let decision: UpgradeDecision | undefined;
    try {
        const result: unknown = hook?.(
            req,
            (accept) => {
                decision ??= { accept };
            },
            (status, reason) => {
                decision ??= { status, reason };
            },
        );
        if (types.isPromise(result)) {
            result.catch(() => undefined);
            return { status: HTTP_STATUS.internalError };
        }
        return decision ?? { status: HTTP_STATUS.notFound };
    } catch {
        return { status: HTTP_STATUS.internalError };
    }
}

function rejectUpgrade(socket: Duplex, status: number, reason?: string): void {
    if (socket.destroyed || !socket.writable) {
        socket.destroy();
        return;
    }
    if (!Number.isInteger(status) || status < 400 || status > 599) {
        status = HTTP_STATUS.internalError;
        reason = undefined;
    }
    const text =
        reason !== undefined && STATUS_REASON.test(reason) ? reason : (STATUS_CODES[status] ?? "");
    socket.once("error", () => socket.destroy());
    socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () =>
        socket.destroy(),
    );
}

function toRequestContext(c: Context): RequestContext {
    const raw = c.req.header();
    const headers: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(raw)) {
        headers[key] = value;
    }
    return { url: c.req.url, headers };
}

export class HttpServer implements TransportAdapter {
    private readonly app: Hono;
    private readonly opts: HttpServerOptions;
    private server: Server | undefined;
    private wss: WebSocketServer | undefined;
    private opening: Promise<void> | undefined;
    private closing: Promise<void> | undefined;
    private readonly sockets = new Set<Socket>();
    private readonly pending = new Set<() => void>();

    /** 请求分发注入点：协议层实现「请求 → 响应」（整机入口，OB11 用）。 */
    onRequest?: (req: unknown, respond: Respond) => void;
    /**
     * 路径路由注入点（协议无关扩展，Satori RPC 用）：
     * 按 path/method 分发。设置了 onPathRequest 时优先于 onRequest。
     */
    onPathRequest?: (ctx: HttpRouteContext, req: unknown, respond: Respond) => void;
    /**
     * 流式/原始响应注入点（协议无关扩展，SSE 等用）：authorize 之后、JSON 解析
     * 之前调用；返回 Response 即短路（整请求由协议层构造），undefined 继续
     * 常规流程。同步判定。
     */
    onRawRequest?: (ctx: HttpRouteContext, req: RequestContext) => Response | undefined;
    /**
     * 同端口 WS 升级注入点（协议无关扩展，Milky /event 等用）：
     * open() 时挂到原生 server 的 upgrade 事件；不设置则升级请求按 Node 默认
     * 行为销毁 socket。
     */
    onUpgrade?: WsUpgradeHook;

    constructor(opts: HttpServerOptions) {
        this.opts = opts;
        this.app = new Hono();
        this.app.onError((err, c) => {
            if (err instanceof RequestError) {
                return c.json({ error: "invalid request" }, HTTP_STATUS.badRequest);
            }
            return c.json({ error: "internal server error" }, HTTP_STATUS.internalError);
        });
        // 请求体上限（2026-11-03 依赖审计整改）：第三方可直接 POST，
        // 无上限时一个超大 JSON 就能把解析阶段的内存打爆。默认值考虑
        // base64 媒体，见 types.ts DEFAULT_MAX_BODY_BYTES。
        this.app.use(
            bodyLimit({
                maxSize: opts.bodyLimitBytes ?? DEFAULT_MAX_BODY_BYTES,
                onError: (c) => c.json({ error: "payload too large" }, HTTP_STATUS.payloadTooLarge),
            }),
        );
        this.app.all("*", (c) => this.handle(c));
    }

    /**
     * 处理所有 HTTP 请求：
     * 鉴权 → 解析 JSON body → 交 onPathRequest / onRequest → 响应。
     * respond 可选 status（Satori 404/501 等）；缺省 200。
     */
    private async handle(c: Context): Promise<Response> {
        if (this.closing) {
            return c.json({ error: "server shutdown" }, HTTP_STATUS.unavailable);
        }
        const { authorize } = this.opts;
        const reqCtx = toRequestContext(c);
        if (authorize) {
            if (!authorize(reqCtx)) {
                return c.json({ error: "unauthorized" }, HTTP_STATUS.unauthorized);
            }
        }

        // 流式响应短路（SSE 等无 JSON body 的端点）：协议层返回即整请求完成
        if (this.onRawRequest !== undefined) {
            const raw = this.onRawRequest({ path: c.req.path, method: c.req.method }, reqCtx);
            if (raw !== undefined) {
                return raw;
            }
        }

        let req: unknown;
        try {
            const body: unknown = await c.req.json();
            req = body;
        } catch {
            return c.json({ error: "invalid json body" }, HTTP_STATUS.badRequest);
        }

        return this.dispatch(c, reqCtx, req);
    }

    private dispatch(c: Context, reqCtx: RequestContext, req: unknown): Promise<Response> {
        return new Promise<Response>((resolve) => {
            let settled = false;
            let timer: ReturnType<typeof setTimeout> | undefined;
            const signal = c.req.raw.signal;
            const finish = (response: Response): void => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                signal.removeEventListener("abort", onAbort);
                this.pending.delete(onClose);
                resolve(response);
            };
            // 客户端已断开，仅结算等待与清理；该状态不会再发送到客户端。
            const onAbort = (): void => finish(new Response(null, { status: 499 }));
            const onClose = (): void =>
                finish(c.json({ error: "server shutdown" }, HTTP_STATUS.unavailable));
            const respond: Respond = (res, status = 200) => {
                if (settled) return;
                try {
                    finish(
                        new Response(res === undefined ? null : JSON.stringify(res), {
                            status,
                            ...(res === undefined
                                ? {}
                                : { headers: { "Content-Type": "application/json" } }),
                        }),
                    );
                } catch {
                    finish(c.json({ error: "internal server error" }, HTTP_STATUS.internalError));
                }
            };
            this.pending.add(onClose);
            signal.addEventListener("abort", onAbort, { once: true });
            if (signal.aborted) {
                onAbort();
                return;
            }
            if (this.closing) {
                onClose();
                return;
            }
            if (this.opts.timeoutMs !== undefined && this.opts.timeoutMs > 0) {
                timer = setTimeout(() => {
                    finish(c.json({ error: "request timeout" }, HTTP_STATUS.timeout));
                }, this.opts.timeoutMs);
                timer.unref();
            }
            try {
                this.invokeHandler(c, reqCtx, req, respond);
            } catch {
                respond({ error: "internal server error" }, HTTP_STATUS.internalError);
            }
        });
    }

    private invokeHandler(
        c: Context,
        reqCtx: RequestContext,
        req: unknown,
        respond: Respond,
    ): void {
        if (this.onPathRequest !== undefined) {
            this.onPathRequest(
                { path: c.req.path, method: c.req.method, headers: reqCtx.headers },
                req,
                respond,
            );
        } else {
            this.onRequest?.(req, respond);
        }
    }

    /** HTTP 反向为被动接收，无主动推送。 */
    send<T>(_payload: T): void {
        // no-op
    }

    open(): Promise<void> {
        if (this.closing) return this.closing.then(() => this.open());
        if (this.opening) return this.opening;
        if (this.server) return Promise.resolve();
        this.opening = this.start().finally(() => {
            this.opening = undefined;
        });
        return this.opening;
    }

    private async start(): Promise<void> {
        const server = createServer(getRequestListener(this.app.fetch));
        this.server = server;
        server.on("connection", (socket) => {
            this.sockets.add(socket);
            socket.once("close", () => this.sockets.delete(socket));
            if (this.closing) socket.destroy();
        });
        try {
            if (this.onUpgrade !== undefined) {
                this.attachUpgrade(server);
            }
            await new Promise<void>((resolve, reject) => {
                const onError = (error: Error): void => {
                    server.removeListener("listening", onListening);
                    reject(error);
                };
                const onListening = (): void => {
                    server.removeListener("error", onError);
                    resolve();
                };
                server.once("error", onError);
                server.once("listening", onListening);
                server.listen(this.opts.port, this.opts.host);
            });
        } catch (error) {
            await this.dispose(server);
            this.server = undefined;
            throw error;
        }
    }

    /**
     * 同端口 WS 升级：挂原生 server 的 upgrade 事件，经 noServer WSS 完成握手。
     * @hono/node-server 默认不监听 upgrade，先挂先得（与 hono 无冲突）。
     */
    private attachUpgrade(server: Server): void {
        const wss = new WebSocketServer({
            noServer: true,
            // 单条消息上限：升级通道与独立 WsServer 同一口径（见 types.ts）。
            // skipUTF8Validation 同 WsServer 显式 false：Milky /event 的入帧同样
            // 要求合法 UTF-8（见 ws-server.ts 注释）。
            maxPayload: this.opts.wsMaxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
            skipUTF8Validation: false,
        });
        this.wss = wss;
        server.on("upgrade", (req, socket: Duplex, head: Buffer) => {
            const decision = decideUpgrade(this.onUpgrade, incomingMessageToRequestContext(req));
            if (this.closing) {
                rejectUpgrade(socket, HTTP_STATUS.unavailable);
                return;
            }
            if ("status" in decision) {
                rejectUpgrade(socket, decision.status, decision.reason);
                return;
            }
            try {
                wss.handleUpgrade(req, socket, head, (client) => {
                    try {
                        const result: unknown = decision.accept(client);
                        if (types.isPromise(result)) {
                            result.catch(() => client.terminate());
                        }
                    } catch {
                        client.terminate();
                    }
                });
            } catch {
                // ws 已接手握手与 socket 监听器，握手内部异常交给 socket 回收。
                socket.destroy();
            }
        });
    }

    close(): Promise<void> {
        if (this.closing) return this.closing;
        this.closing = this.stop().finally(() => {
            this.closing = undefined;
        });
        return this.closing;
    }

    private async stop(): Promise<void> {
        // 启动错误仍由 open() 的调用方接收；start() 自行清理失败实例。
        if (this.opening) {
            await this.opening.then(
                () => undefined,
                () => undefined,
            );
        }
        const server = this.server;
        if (!server) return;
        await this.dispose(server);
        this.server = undefined;
    }

    private async dispose(server: Server): Promise<void> {
        server.removeAllListeners("upgrade");
        const httpClosed = new Promise<void>((resolve) => server.close(() => resolve()));
        // Node 的 server.close 不等待已升级的 TCP 连接，单独等待它们释放。
        const socketsClosed = [...this.sockets].map(
            (socket) => new Promise<void>((resolve) => socket.once("close", () => resolve())),
        );
        for (const finish of this.pending) finish();
        const wss = this.wss;
        const wsClosed = new Promise<void>((resolve) => {
            if (!wss) {
                resolve();
                return;
            }
            wss.close(() => resolve());
            for (const client of wss.clients) client.close(1001, "server shutdown");
        });
        const timer = setTimeout(() => {
            if (wss) for (const client of wss.clients) client.terminate();
            for (const socket of this.sockets) socket.destroy();
        }, CLOSE_GRACE_MS);
        timer.unref();
        try {
            await Promise.all([httpClosed, wsClosed, ...socketsClosed]);
        } finally {
            clearTimeout(timer);
            this.wss = undefined;
            server.removeAllListeners();
        }
    }
}
