/**
 * 反向 WS server（被动，第三方主动连入）
 *
 * 收到消息 → `onRequest` 注入点（协议层分发）→ 响应经 `respond` 回发**同一客户端**。
 * 握手鉴权通过 `authorize` 钩子；调用方也可用 `onConnection` 登记连接以进行带内鉴权。
 */
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, STATUS_CODES } from "node:http";
import type { Socket } from "node:net";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import { closeServerConnections } from "./server-lifecycle.js";
import {
    incomingMessageToRequestContext,
    isWsOpen,
    type RequestContext,
    type Respond,
    type TransportAdapter,
    type WsServerOptions,
    type WsSocket,
} from "./types.js";
import { sendWsText, startWsHeartbeat, wsPayloadLimit } from "./ws-flow.js";

const WS_CLOSE_CODE = {
    unauthorized: 4401,
} as const;

interface WsListener {
    http: Server;
    wss: WebSocketServer;
    sockets: Set<Socket>;
}

export class WsServer implements TransportAdapter {
    private readonly opts: WsServerOptions;
    private listener: WsListener | undefined;
    private opening: Promise<void> | undefined;
    private closing: Promise<void> | undefined;
    private readonly heartbeats = new Map<WsSocket, () => void>();

    /**
     * 请求分发注入点：协议层实现「请求 → 响应」（status 参数 WS 下忽略）。
     * 第三参为发起该请求的连接（带内鉴权协议据此登记「已认证」状态）。
     */
    onRequest?: (req: unknown, respond: Respond, socket: WsSocket) => void;
    /**
     * 连接建立钩子（authorize 通过后触发），供调用方登记连接或初始化会话状态。
     */
    onConnection?: (socket: WsSocket, req: RequestContext) => void;

    constructor(opts: WsServerOptions) {
        this.opts = opts;
    }

    /** 广播给所有已连接客户端（序列化后发送）。 */
    send<T>(payload: T): void {
        if (!this.listener || this.closing) return;
        sendWsText(this.listener.wss.clients, JSON.stringify(payload), this.opts.maxBufferedBytes);
    }

    open(): Promise<void> {
        if (this.closing) return this.closing.then(() => this.open());
        if (this.opening) return this.opening;
        if (this.listener) return Promise.resolve();
        this.opening = this.start().finally(() => {
            this.opening = undefined;
        });
        return this.opening;
    }

    private async start(): Promise<void> {
        const { host, port, path } = this.opts;
        // 持有原生监听器才能在关停时回收仍未升级的 TCP。
        const http = createServer((_req, res) => {
            const body = STATUS_CODES[426] ?? "Upgrade Required";
            res.writeHead(426, { "Content-Length": body.length, "Content-Type": "text/plain" });
            res.end(body);
        });
        const wss = new WebSocketServer({
            server: http,
            maxPayload: wsPayloadLimit(this.opts.maxPayloadBytes),
            skipUTF8Validation: false,
            ...(path === undefined ? {} : { path }),
        });
        const sockets = new Set<Socket>();
        const listener = { http, wss, sockets };
        http.on("connection", (socket) => {
            sockets.add(socket);
            socket.once("close", () => sockets.delete(socket));
            if (this.closing) socket.destroy();
        });
        wss.on("connection", (socket, req) => this.handleConnection(socket, req));
        try {
            http.listen(port, host);
            await once(wss, "listening");
        } catch (err) {
            await this.dispose(listener);
            throw err;
        }
        this.listener = listener;
    }

    close(): Promise<void> {
        if (this.closing) return this.closing;
        this.closing = this.stop().finally(() => {
            this.closing = undefined;
        });
        return this.closing;
    }

    private async stop(): Promise<void> {
        // 启动失败由 open() 的调用方接收，start() 回收半初始化监听器。
        if (this.opening) await this.opening.catch(() => undefined);
        const { listener } = this;
        if (!listener) return;
        await this.dispose(listener);
        this.listener = undefined;
    }

    private async dispose({ http, wss, sockets }: WsListener): Promise<void> {
        for (const stop of this.heartbeats.values()) stop();
        this.heartbeats.clear();
        wss.removeAllListeners("connection");
        try {
            await closeServerConnections(http, sockets, wss);
        } finally {
            http.removeAllListeners();
        }
    }

    private handleConnection(socket: WebSocket, req: IncomingMessage): void {
        socket.on("error", () => socket.terminate());
        const ctx = incomingMessageToRequestContext(req);
        if (this.opts.authorize && !this.opts.authorize(ctx)) {
            socket.close(WS_CLOSE_CODE.unauthorized, "unauthorized");
            return;
        }
        if (this.opts.heartbeat) {
            this.heartbeats.set(socket, startWsHeartbeat(socket, this.opts.heartbeat));
            socket.once("close", () => this.heartbeats.delete(socket));
        }
        // 握手通过（或未配置鉴权）后再交协议层登记，避免把待拒绝的连接暴露给上层。
        this.onConnection?.(socket, ctx);

        const onMessage = (raw: RawData): void => {
            if (this.closing) return;
            let reqBody: unknown;
            try {
                const parsed: unknown = JSON.parse(raw.toString());
                reqBody = parsed;
            } catch {
                // 非 JSON 消息：忽略（协议层只处理 JSON 请求）
                return;
            }
            this.onRequest?.(
                reqBody,
                (res) => {
                    if (isWsOpen(socket)) {
                        sendWsText([socket], JSON.stringify(res), this.opts.maxBufferedBytes);
                    }
                },
                socket,
            );
        };
        socket.on("message", onMessage);
        socket.once("close", () => socket.off("message", onMessage));
    }
}
