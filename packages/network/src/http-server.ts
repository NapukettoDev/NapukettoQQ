/**
 * 反向 HTTP server（hono + @hono/node-server）
 *
 * 接收第三方调用：POST JSON → `onRequest` 注入点（协议层分发）→ 响应回发。
 * 鉴权（token）通过 `authorize` 钩子，规则由协议层决定。
 */

import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { getRequestListener, RequestError } from "@hono/node-server";
import type { Context } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { WebSocketServer } from "ws";
import { dispatchJsonRequest } from "./http/request-dispatcher.js";
import { attachWsUpgrade } from "./http/ws-upgrade.js";
import { closeServerConnections } from "./server-lifecycle.js";
import {
    DEFAULT_MAX_BODY_BYTES,
    type HttpRouteContext,
    type HttpServerOptions,
    type RequestContext,
    type Respond,
    type TransportAdapter,
    type WsUpgradeHook,
} from "./types.js";
import { wsPayloadLimit } from "./ws-flow.js";

const HTTP_STATUS = {
    badRequest: 400,
    unauthorized: 401,
    payloadTooLarge: 413,
    internalError: 500,
    unavailable: 503,
} as const;

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
        // 在 JSON 解析前限制请求体大小；默认上限兼顾 base64 媒体。
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

        return dispatchJsonRequest(
            c,
            this.pending,
            this.opts,
            () => this.closing !== undefined,
            (respond) => this.invokeHandler(c, reqCtx, req, respond),
        );
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

    /** 由 HTTP 生命周期持有同端口 WebSocket 服务。 */
    private attachUpgrade(server: Server): void {
        const wss = new WebSocketServer({
            noServer: true,
            maxPayload: wsPayloadLimit(this.opts.wsMaxPayloadBytes),
            skipUTF8Validation: false,
        });
        this.wss = wss;
        attachWsUpgrade(
            server,
            wss,
            () => this.onUpgrade,
            () => this.closing !== undefined,
        );
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
        for (const finish of this.pending) finish();
        try {
            await closeServerConnections(server, this.sockets, this.wss);
        } finally {
            this.wss = undefined;
            server.removeAllListeners();
        }
    }
}
