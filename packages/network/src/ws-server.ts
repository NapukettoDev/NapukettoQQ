/**
 * 反向 WS server（被动，第三方主动连入）
 *
 * 收到消息 → `onRequest` 注入点（协议层分发）→ 响应经 `respond` 回发**同一客户端**。
 * 鉴权（token）通过 `authorize` 钩子；心跳按间隔 ping 全部客户端。
 */
import type { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import {
    DEFAULT_MAX_PAYLOAD_BYTES,
    type RequestContext,
    type Respond,
    type TransportAdapter,
    type WsServerOptions,
} from "./types.js";

const WS_CLOSE_CODE = {
    unauthorized: 4401,
} as const;

function toRequestContext(req: IncomingMessage): RequestContext {
    const headers: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(req.headers)) {
        if (Array.isArray(value)) {
            headers[key] = value.join(", ");
        } else {
            headers[key] = value;
        }
    }
    return { url: req.url ?? "", headers };
}

export class WsServer implements TransportAdapter {
    private readonly opts: WsServerOptions;
    private wss: WebSocketServer | undefined;
    private heartbeatTimer: NodeJS.Timeout | undefined;

    /** 请求分发注入点：协议层实现「请求 → 响应」（status 参数 WS 下忽略）。 */
    onRequest?: (req: unknown, respond: Respond) => void;

    constructor(opts: WsServerOptions) {
        this.opts = opts;
    }

    /** 广播给所有已连接客户端（序列化后发送）。 */
    send<T>(payload: T): void {
        const { wss } = this;
        if (!wss) {
            return;
        }
        const data = JSON.stringify(payload);
        for (const client of wss.clients) {
            if (client.readyState === WebSocket.OPEN) {
                client.send(data);
            }
        }
    }

    async open(): Promise<void> {
        if (this.wss) {
            return;
        }
        const { host, port, path } = this.opts;
        // 单消息上限：ws 默认 100 MiB 过宽（见 types.ts DEFAULT_MAX_PAYLOAD_BYTES）
        const serverOptions: {
            host: string;
            port: number;
            path?: string;
            maxPayload: number;
        } = {
            host,
            port,
            maxPayload: this.opts.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
        };
        if (path !== undefined) {
            serverOptions.path = path;
        }
        const wss = new WebSocketServer(serverOptions);
        wss.on("connection", (socket, req) => this.onConnection(socket, req));
        this.wss = wss;

        if (this.opts.heartbeat) {
            this.heartbeatTimer = setInterval(() => {
                for (const client of wss.clients) {
                    if (client.readyState === WebSocket.OPEN) {
                        client.ping();
                    }
                }
            }, this.opts.heartbeat.intervalMs);
        }

        await new Promise<void>((resolve, reject) => {
            wss.once("listening", () => resolve());
            wss.once("error", (err) => reject(err));
        });
    }

    async close(): Promise<void> {
        if (this.heartbeatTimer !== undefined) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = undefined;
        }
        const { wss } = this;
        if (!wss) {
            return;
        }
        await new Promise<void>((resolve) => {
            for (const client of wss.clients) {
                client.close();
            }
            wss.close(() => {
                this.wss = undefined;
                resolve();
            });
        });
    }

    private onConnection(socket: WebSocket, req: IncomingMessage): void {
        if (this.opts.authorize && !this.opts.authorize(toRequestContext(req))) {
            socket.close(WS_CLOSE_CODE.unauthorized, "unauthorized");
            return;
        }

        socket.on("message", (raw) => {
            let reqBody: unknown;
            try {
                reqBody = JSON.parse(raw.toString()) as unknown;
            } catch {
                // 非 JSON 消息：忽略（协议层只处理 JSON 请求）
                return;
            }
            this.onRequest?.(reqBody, (res) => {
                if (socket.readyState === WebSocket.OPEN) {
                    socket.send(JSON.stringify(res));
                }
            });
        });
    }
}
