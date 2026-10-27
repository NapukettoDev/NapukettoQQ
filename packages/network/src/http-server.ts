/**
 * 反向 HTTP server（hono + @hono/node-server）
 *
 * 接收第三方调用：POST JSON → `onRequest` 注入点（协议层分发）→ 响应回发。
 * 鉴权（token）通过 `authorize` 钩子，规则由协议层决定。
 */

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { ServerType } from "@hono/node-server";
import { serve } from "@hono/node-server";
import type { Context } from "hono";
import { Hono } from "hono";
import { WebSocketServer } from "ws";
import type {
    HttpRouteContext,
    HttpServerOptions,
    RequestContext,
    Respond,
    TransportAdapter,
    WsUpgradeHook,
} from "./types.js";

const HTTP_STATUS = {
    badRequest: 400,
    unauthorized: 401,
} as const;

/** 原生 server 的 upgrade 监听最小面（@hono/node-server ServerType 收窄用）。 */
interface UpgradeableServer {
    on(
        event: "upgrade",
        listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void,
    ): unknown;
}

function toRequestContext(c: Context): RequestContext {
    const raw = c.req.header();
    const headers: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(raw)) {
        headers[key] = value;
    }
    return { url: c.req.url, headers };
}

/** 原生 upgrade 请求 → RequestContext（headers 展平，url 含查询串）。 */
function toUpgradeRequestContext(req: IncomingMessage): RequestContext {
    const headers: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(req.headers)) {
        headers[key] = Array.isArray(value) ? value.join(", ") : value;
    }
    return { url: req.url ?? "", headers };
}

export class HttpServer implements TransportAdapter {
    private readonly app: Hono;
    private readonly opts: HttpServerOptions;
    private server: ServerType | undefined;

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
        this.app.all("*", (c) => this.handle(c));
    }

    /**
     * 处理所有 HTTP 请求：
     * 鉴权 → 解析 JSON body → 交 onPathRequest / onRequest → 响应。
     * respond 可选 status（Satori 404/501 等）；缺省 200。
     */
    private async handle(c: Context): Promise<Response> {
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
            req = (await c.req.json()) as unknown;
        } catch {
            return c.json({ error: "invalid json body" }, HTTP_STATUS.badRequest);
        }

        return new Promise<Response>((resolve) => {
            const respond: Respond = (res, status) => {
                const statusCode = status ?? 200;
                // res === undefined：无 body 响应（协议层定义 401/404 等空 body 语义用）
                if (res === undefined) {
                    resolve(new Response(null, { status: statusCode }));
                    return;
                }
                resolve(
                    new Response(JSON.stringify(res), {
                        status: statusCode,
                        headers: { "Content-Type": "application/json" },
                    }),
                );
            };
            if (this.onPathRequest !== undefined) {
                this.onPathRequest(
                    { path: c.req.path, method: c.req.method, headers: reqCtx.headers },
                    req,
                    respond,
                );
            } else {
                this.onRequest?.(req, respond);
            }
        });
    }

    /** HTTP 反向为被动接收，无主动推送。 */
    send<T>(_payload: T): void {
        // no-op
    }

    async open(): Promise<void> {
        if (this.server) {
            return;
        }
        await new Promise<void>((resolve, _reject) => {
            const srv = serve(
                {
                    fetch: this.app.fetch,
                    hostname: this.opts.host,
                    port: this.opts.port,
                },
                () => {
                    this.server = srv;
                    resolve();
                },
            );
            if (this.onUpgrade !== undefined) {
                this.attachUpgrade(srv);
            }
        });
    }

    /**
     * 同端口 WS 升级：挂原生 server 的 upgrade 事件，经 noServer WSS 完成握手。
     * @hono/node-server 默认不监听 upgrade，先挂先得（与 hono 无冲突）。
     */
    private attachUpgrade(server: ServerType): void {
        const wss = new WebSocketServer({ noServer: true });
        const upgradeable = server as unknown as UpgradeableServer;
        upgradeable.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
            this.onUpgrade?.(
                toUpgradeRequestContext(req),
                (accept) => {
                    wss.handleUpgrade(req, socket, head, (client) => accept(client));
                },
                (status, reason) => {
                    const text = reason ?? "";
                    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
                    socket.destroy();
                },
            );
        });
    }

    async close(): Promise<void> {
        const { server } = this;
        if (!server) {
            return;
        }
        await new Promise<void>((resolve) => {
            server.close(() => {
                this.server = undefined;
                resolve();
            });
        });
    }
}
