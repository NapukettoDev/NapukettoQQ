/**
 * 反向 WS server（被动，第三方主动连入）
 *
 * 收到消息 → `onRequest` 注入点（协议层分发）→ 响应经 `respond` 回发**同一客户端**。
 * 鉴权（token）通过 `authorize` 钩子；握手期无法携带凭据的协议（Satori 的带内
 * IDENTIFY）改用 `onConnection` 钩子自行登记连接。心跳按间隔 ping 全部客户端。
 */
import type { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import {
    DEFAULT_MAX_PAYLOAD_BYTES,
    incomingMessageToRequestContext,
    type RequestContext,
    type Respond,
    type TransportAdapter,
    type WsServerOptions,
    type WsSocket,
} from "./types.js";

const WS_CLOSE_CODE = {
    unauthorized: 4401,
} as const;

export class WsServer implements TransportAdapter {
    private readonly opts: WsServerOptions;
    private wss: WebSocketServer | undefined;
    private heartbeatTimer: NodeJS.Timeout | undefined;

    /**
     * 请求分发注入点：协议层实现「请求 → 响应」（status 参数 WS 下忽略）。
     * 第三参为发起该请求的连接（带内鉴权协议据此登记「已认证」状态）。
     */
    onRequest?: (req: unknown, respond: Respond, socket: WsSocket) => void;
    /**
     * 连接建立钩子（authorize 通过后触发）：握手期不带凭据的协议（如 Satori 的
     * IDENTIFY 带内鉴权）在这里登记连接、启动认证超时或初始化会话状态。
     */
    onConnection?: (socket: WsSocket, req: RequestContext) => void;

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
        // 单消息上限：ws 默认 100 MiB 过宽（见 types.ts DEFAULT_MAX_PAYLOAD_BYTES）。
        // skipUTF8Validation 显式 false：文本帧进入 JSON.parse / 日志前必须已校验
        // UTF-8（ws 默认即 false，写死防止后人为了「微秒级性能」关掉——非法字节流
        // 会在下游变成乱码或异常，而不是可诊断的协议错误）。
        const serverOptions: {
            host: string;
            port: number;
            path?: string;
            maxPayload: number;
            skipUTF8Validation: boolean;
        } = {
            host,
            port,
            maxPayload: this.opts.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
            skipUTF8Validation: false,
        };
        if (path !== undefined) {
            serverOptions.path = path;
        }
        const wss = new WebSocketServer(serverOptions);
        const onConnection = (socket: WebSocket, req: IncomingMessage): void =>
            this.handleConnection(socket, req);
        wss.on("connection", onConnection);

        // 等 listening 成功后才挂到 this.wss / 启动心跳：error 分支不残留半初始化状态。
        try {
            await new Promise<void>((resolve, reject) => {
                const onListening = (): void => {
                    wss.off("error", onError);
                    resolve();
                };
                const onError = (err: Error): void => {
                    wss.off("listening", onListening);
                    reject(err);
                };
                wss.once("listening", onListening);
                wss.once("error", onError);
            });
        } catch (err) {
            wss.off("connection", onConnection);
            // 半初始化 server：挂临时 error 监听再 close，防止 close 自身报错逃逸。
            wss.on("error", () => undefined);
            wss.close();
            throw err;
        }
        this.wss = wss;

        if (this.opts.heartbeat) {
            this.heartbeatTimer = setInterval(() => {
                for (const client of wss.clients) {
                    if (client.readyState === WebSocket.OPEN) {
                        client.ping();
                    }
                }
            }, this.opts.heartbeat.intervalMs);
            // 不阻塞进程自然退出
            this.heartbeatTimer.unref?.();
        }
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

    private handleConnection(socket: WebSocket, req: IncomingMessage): void {
        const ctx = incomingMessageToRequestContext(req);
        if (this.opts.authorize && !this.opts.authorize(ctx)) {
            socket.close(WS_CLOSE_CODE.unauthorized, "unauthorized");
            return;
        }
        // 握手通过（或未配置鉴权）后再交协议层登记，避免把待拒绝的连接暴露给上层。
        this.onConnection?.(socket, ctx);

        socket.on("message", (raw) => {
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
                    if (socket.readyState === WebSocket.OPEN) {
                        socket.send(JSON.stringify(res));
                    }
                },
                socket,
            );
        });
    }
}
