/**
 * 测试支撑：假 kurobridge-ws 服务端（ws 库起真端口，任务书阶段 2）。
 *
 * 仅供相邻 *.test.ts 使用（vitest 根配置 include *.test.ts；本文件不进 tsdown
 * 构建产物）。握手子协议校验复刻 KuroAdapter NodeWsServer（handleProtocols 不带
 * `kurobridge-ws.v1` 返回 false = 拒连）；hello 的应答行为由用例注入。
 */
import { type WebSocket, WebSocketServer } from "ws";
import { encodeFrame, WS_SUBPROTOCOL } from "./schema.js";

/** 服务端视角收到的帧（已 JSON 解析）。 */
export interface FakeServerFrame {
    header: { type: string; id?: string };
    body: unknown;
}

/** 假 kurobridge-ws 服务端。 */
export interface FakeKurobotServer {
    port: number;
    /** 全部收到的客户端帧（跨连接累计）。 */
    frames: FakeServerFrame[];
    /** 每个新连接的握手子协议（handleProtocols 捕获；无子协议为 null）。 */
    handshakes: (string | null)[];
    /** 活跃连接（每连接 onMessage 可注入行为）。 */
    connections: WebSocket[];
    /** 注入：收到客户端帧时的处理（缺省不回应）。 */
    onClientFrame: (frame: FakeServerFrame, conn: WebSocket) => void;
    /** 等待下一个连接（并注入 onMessage 行为后返回）。 */
    nextConnection(): Promise<WebSocket>;
    /** 向指定连接发帧（扁平 → 线格式）。 */
    send(conn: WebSocket, message: { type: string; body: unknown; id?: string }): void;
    /** 服务端关连接（code 可选 1002/1008/1001）。 */
    close(conn: WebSocket, code: number, reason?: string): void;
    /** 停服务。 */
    stop(): Promise<void>;
}

/** 启动假服务端（listen(0) 动态端口）。 */
export async function startFakeKurobotServer(): Promise<FakeKurobotServer> {
    const server: FakeKurobotServer = {
        port: 0,
        frames: [],
        handshakes: [],
        connections: [],
        onClientFrame: () => undefined,
        nextConnection: () => {
            throw new Error("未初始化");
        },
        send: () => undefined,
        close: () => undefined,
        stop: () => Promise.resolve(),
    };
    const wss = new WebSocketServer({
        port: 0,
        // 复刻 KuroAdapter NodeWsServer：不带子协议直接拒连（HTTP 401）
        handleProtocols: (protocols) => {
            const accepted = protocols.has(WS_SUBPROTOCOL) ? WS_SUBPROTOCOL : false;
            server.handshakes.push(accepted === false ? null : accepted);
            return accepted;
        },
    });
    await new Promise<void>((resolve, reject) => {
        wss.once("listening", () => resolve());
        wss.once("error", (err) => reject(err));
    });
    // 持久连接处理：入站帧记录 + 注入 onClientFrame（不依赖用例是否调 nextConnection）
    const connectionWaiters: ((conn: WebSocket) => void)[] = [];
    wss.on("connection", (conn: WebSocket) => {
        server.connections.push(conn);
        conn.on("message", (data) => {
            const frame = JSON.parse(String(data)) as FakeServerFrame;
            server.frames.push(frame);
            server.onClientFrame(frame, conn);
        });
        const waiter = connectionWaiters.shift();
        waiter?.(conn);
    });
    const address = wss.address();
    if (typeof address !== "object" || address === null) {
        throw new Error(`假服务端地址异常：${String(address)}`);
    }
    server.port = address.port;
    server.nextConnection = () =>
        new Promise<WebSocket>((resolve) => {
            connectionWaiters.push(resolve);
        });
    server.send = (conn, message) => {
        conn.send(encodeFrame(message));
    };
    server.close = (conn, code, reason = "") => {
        conn.close(code, reason);
    };
    server.stop = () => {
        // 先 terminate 全部连接（适配器 stop 不保证收到 stop 调用，残留连接会让
        // wss.close 的回调永不触发 → afterAll 挂起）
        for (const conn of server.connections) {
            conn.terminate();
        }
        return new Promise<void>((resolve, reject) => {
            wss.close((error) => (error === undefined ? resolve() : reject(error)));
        });
    };
    return server;
}

/** 轮询等待（ws 时序依赖事件循环，10ms 步进比挂事件更适合跨层断言）。 */
export async function waitFor<T>(fn: () => T | undefined | null, timeoutMs = 2000): Promise<T> {
    const stepMs = 10;
    let waited = 0;
    for (;;) {
        const value = fn();
        if (value !== undefined && value !== null) {
            return value;
        }
        if (waited >= timeoutMs) {
            throw new Error(`waitFor 超时（${String(timeoutMs)}ms）`);
        }
        await new Promise<void>((resolve) => setTimeout(resolve, stepMs));
        waited += stepMs;
    }
}
