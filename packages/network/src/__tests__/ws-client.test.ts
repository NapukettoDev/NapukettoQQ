/**
 * WsClient（正向 WS 客户端）测试
 *
 * 真实 127.0.0.1 临时端口端到端（服务端用 ws 官方 WebSocketServer 桩）。
 * 锁定：open 成功/失败语义、open 幂等（连接中/已连接不重复建连）、
 * send 在 OPEN/未连接/已关闭三态行为、消息分发与回发、非 JSON 忽略、
 * 自定义 headers 透传、心跳（fake timers）、断线重连（fake timers：
 * delayMs 定时、成功归零、失败累计 attempt、maxAttempts 停止、close 取消）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type WebSocket as ClientSocket, WebSocketServer } from "ws";
import { WsClient } from "../ws-client.js";
import { realDelay, take, waitJsonMessage } from "./test-support.js";

/** WsClient 私有重连状态（仅测试观察用，不改被测类型）。 */
interface ReconnectInternals {
    attempt: number;
    reconnectTimer?: NodeJS.Timeout;
}

/** 读取客户端内部状态（跨层断言收窄，不放宽被测类型）。 */
function internals(client: WsClient): ReconnectInternals {
    return client as unknown as ReconnectInternals;
}

/** 服务端桩：记录每条连接（可逐条操控），close 时强制断开全部并幂等。 */
interface WssStub {
    wss: WebSocketServer;
    url: string;
    sockets: ClientSocket[];
    close: () => Promise<void>;
}

/** 起一个 ws 服务端桩（端口 0 自动分配）。 */
async function listenWss(): Promise<WssStub> {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const sockets: ClientSocket[] = [];
    wss.on("connection", (socket) => {
        sockets.push(socket);
    });
    await new Promise<void>((resolve, reject) => {
        wss.once("listening", () => resolve());
        wss.once("error", (err) => reject(err));
    });
    const addr = wss.address();
    if (addr === null || typeof addr === "string") {
        throw new Error("未取得临时端口");
    }
    let closed = false;
    return {
        wss,
        url: `ws://127.0.0.1:${addr.port}`,
        sockets,
        close: () =>
            new Promise<void>((resolve) => {
                if (closed) {
                    resolve();
                    return;
                }
                closed = true;
                for (const socket of sockets) {
                    socket.terminate();
                }
                wss.close(() => resolve());
            }),
    };
}

/** 服务端第一条连接（noUncheckedIndexedAccess 收窄）。 */
function firstSocket(stub: WssStub): ClientSocket {
    return take(stub.sockets[0], "服务端未见连接");
}

describe("WsClient", () => {
    const stubs: WssStub[] = [];
    const clients: WsClient[] = [];
    afterEach(async () => {
        for (const client of clients.reverse()) {
            client.close();
        }
        clients.length = 0;
        for (const stub of stubs.reverse()) {
            await stub.close();
        }
        stubs.length = 0;
    });

    /** 起服务端桩并登记清理。 */
    async function serve(): Promise<WssStub> {
        const stub = await listenWss();
        stubs.push(stub);
        return stub;
    }

    /** 创建客户端并登记清理。 */
    function makeClient(opts: ConstructorParameters<typeof WsClient>[0]): WsClient {
        const client = new WsClient(opts);
        clients.push(client);
        return client;
    }

    it("open 成功建立连接；服务端收到自定义 headers", async () => {
        const stub = await serve();
        let seenHeader: string | string[] | undefined;
        stub.wss.on("connection", (_socket, req) => {
            seenHeader = req.headers["x-test"];
        });
        const client = makeClient({ url: stub.url, headers: { "x-test": "napuketto" } });

        await client.open();
        await vi.waitFor(() => expect(stub.sockets).toHaveLength(1));
        expect(seenHeader).toBe("napuketto");
        expect(internals(client).attempt).toBe(0);
    });

    it("无服务时 open 失败 reject；失败后可再次尝试（不残留连接引用）", async () => {
        const stub = await serve();
        const { url } = stub;
        await stub.close();

        const client = makeClient({ url });
        await expect(client.open()).rejects.toThrow();

        // 失败清引用：内部 ws 槽位为空，二次 open 会真实重试（依旧失败）
        await expect(client.open()).rejects.toThrow();
    });

    it("rejectUnauthorized: false 透传（ws:// 下不破坏连接）", async () => {
        const stub = await serve();
        const client = makeClient({ url: stub.url, rejectUnauthorized: false });
        await client.open();
        await vi.waitFor(() => expect(stub.sockets).toHaveLength(1));
    });

    it("open 幂等：连接中重复 open 不产生第二条连接", async () => {
        const stub = await serve();
        const client = makeClient({ url: stub.url });

        const first = client.open();
        const second = client.open();
        await Promise.all([first, second]);
        await client.open();

        await vi.waitFor(() => expect(stub.sockets).toHaveLength(1));
    });

    it("send：OPEN 时发送 JSON；未连接与已关闭时静默 no-op", async () => {
        const stub = await serve();
        const client = makeClient({ url: stub.url });

        expect(() => client.send({ before: true })).not.toThrow();

        await client.open();
        client.send({ hello: 1 });
        await expect(waitJsonMessage(firstSocket(stub))).resolves.toEqual({ hello: 1 });

        await client.close();
        expect(() => client.send({ after: true })).not.toThrow();
        expect(stub.sockets).toHaveLength(1);
    });

    it("服务端消息经 onRequest 分发，respond 回发服务端；非 JSON 忽略", async () => {
        const stub = await serve();
        const client = makeClient({ url: stub.url });
        client.onRequest = (req, respond) => {
            respond({ pong: req });
        };
        await client.open();

        const serverSocket = firstSocket(stub);
        serverSocket.send("not-json");
        serverSocket.send(JSON.stringify({ ping: 1 }));

        await expect(waitJsonMessage(serverSocket)).resolves.toEqual({ pong: { ping: 1 } });
    });

    it("close 关闭连接并幂等（重复 close 安全）", async () => {
        const stub = await serve();
        const client = makeClient({ url: stub.url });
        await client.open();
        const serverSocket = firstSocket(stub);
        const closed = new Promise<void>((resolve) => {
            serverSocket.once("close", () => resolve());
        });

        await client.close();
        await client.close();
        await closed;
    });

    describe("心跳（fake timers）", () => {
        beforeEach(() => {
            vi.useFakeTimers({
                toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
            });
        });
        afterEach(() => {
            vi.useRealTimers();
        });

        it("heartbeat 按间隔向服务端 ping", async () => {
            const stub = await serve();
            let pings = 0;
            stub.wss.on("connection", (socket) => {
                socket.on("ping", () => {
                    pings += 1;
                });
            });
            const client = makeClient({ url: stub.url, heartbeat: { intervalMs: 50 } });
            await client.open();

            await vi.advanceTimersByTimeAsync(160);
            await realDelay(30);
            expect(pings).toBeGreaterThanOrEqual(3);
        });
    });

    describe("重连（fake timers）", () => {
        beforeEach(() => {
            vi.useFakeTimers({
                toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
            });
        });
        afterEach(() => {
            vi.useRealTimers();
        });

        it("open 失败不调度重连（即使 reconnect.enabled，stale close 防护）", async () => {
            const stub = await serve();
            const { url } = stub;
            await stub.close();

            const client = makeClient({
                url,
                reconnect: { enabled: true, delayMs: 10 },
            });
            await expect(client.open()).rejects.toThrow();
            await realDelay(20);
            await vi.advanceTimersByTimeAsync(50);

            expect(internals(client).reconnectTimer).toBeUndefined();
            expect(internals(client).attempt).toBe(0);
        });

        it("断线后按 delayMs 重连成功，attempt 归零、可继续收发", async () => {
            const stub = await serve();
            const client = makeClient({
                url: stub.url,
                reconnect: { enabled: true, delayMs: 50 },
            });
            await client.open();
            expect(stub.sockets).toHaveLength(1);

            const secondConn = new Promise<void>((resolve) => {
                stub.wss.once("connection", () => resolve());
            });
            firstSocket(stub).close();
            await realDelay(30); // 客户端 close 事件落地、重连定时器入队

            await vi.advanceTimersByTimeAsync(70);
            await secondConn;
            await realDelay(20); // 等待客户端侧 open（attempt 归零）
            expect(stub.sockets).toHaveLength(2);

            client.send({ again: true });
            const reconnected = take(stub.sockets[1], "重连未见连接");
            await expect(waitJsonMessage(reconnected)).resolves.toEqual({ again: true });
            expect(internals(client).attempt).toBe(0);
        });

        it("未启用重连（缺省）→ 断线后不重连", async () => {
            const stub = await serve();
            const client = makeClient({ url: stub.url });
            await client.open();

            firstSocket(stub).close();
            await vi.advanceTimersByTimeAsync(200);
            await realDelay(20);

            expect(stub.sockets).toHaveLength(1);
            expect(internals(client).reconnectTimer).toBeUndefined();
        });

        it("重连失败累计 attempt，超过 maxAttempts 停止", async () => {
            const stub = await serve();
            const { url } = stub;
            const client = makeClient({
                url,
                reconnect: { enabled: true, delayMs: 10, maxAttempts: 1 },
            });
            await client.open();

            // 服务端整体关闭 → 客户端断线 → attempt=1 → 定时重连
            await stub.close();
            await vi.advanceTimersByTimeAsync(20);
            await realDelay(20); // 真实 ECONNREFUSED 落地
            await vi.advanceTimersByTimeAsync(20);
            await realDelay(20);

            // attempt=2 > maxAttempts(1) → 停止，不再调度
            expect(internals(client).attempt).toBe(2);
            expect(internals(client).reconnectTimer).toBeUndefined();
        });

        it("close 取消挂起的重连定时器（closed 标记阻断重连）", async () => {
            const stub = await serve();
            const { url } = stub;
            const client = makeClient({
                url,
                reconnect: { enabled: true, delayMs: 60 },
            });
            await client.open();

            await stub.close();
            await realDelay(10);
            expect(internals(client).reconnectTimer).toBeDefined();

            await client.close();
            expect(internals(client).reconnectTimer).toBeUndefined();
            await vi.advanceTimersByTimeAsync(120);
            await realDelay(20);
            expect(internals(client).attempt).toBe(1); // 未再推进
        });
    });
});
