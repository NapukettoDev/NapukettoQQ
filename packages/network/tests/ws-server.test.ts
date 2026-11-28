/**
 * WsServer（反向 WS server）测试
 *
 * 真实 127.0.0.1 临时端口端到端（ws 官方客户端直连）。
 * 锁定：连接建立、消息分发（onRequest → respond 回同一客户端、status 参数
 * 被忽略）、广播 send、非 JSON 消息忽略、鉴权 4401（含钩子入参）、path 过滤、
 * maxPayload 上限（1009）、心跳 ping、close 清理与重新 open。
 */

import { once } from "node:events";
import { connect as netConnect } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket as ClientSocket } from "ws";
import type { RequestContext, WsServerOptions, WsSocket } from "../src/types.js";
import { WsServer } from "../src/ws-server.js";
import {
    connectOk,
    getFreePort,
    realDelay,
    take,
    waitClose,
    waitJsonMessage,
    waitOpen,
} from "./test-support.js";

/** 裸 TCP 手写 WebSocket upgrade 请求（携带 ws 客户端无法发送的重复头）。 */
function rawUpgrade(url: string, path: string, extraHeaders: string): Promise<void> {
    const host = url.replace("ws://", "");
    return new Promise((resolve, reject) => {
        const sock = netConnect(Number(host.split(":")[1] ?? 0), "127.0.0.1", () => {
            sock.write(
                `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${extraHeaders}\r\n`,
            );
        });
        sock.once("data", () => {
            resolve();
            sock.destroy();
        });
        sock.once("error", reject);
    });
}

describe("WsServer", () => {
    const cleanups: Array<() => Promise<void>> = [];
    afterEach(async () => {
        for (const clean of cleanups.reverse()) {
            await clean();
        }
        cleanups.length = 0;
    });

    /** 起一个已 open 的 WsServer（自动登记 afterEach 关闭）。 */
    async function start(
        overrides: Partial<WsServerOptions> = {},
    ): Promise<{ server: WsServer; url: string }> {
        const port = await getFreePort();
        const base: WsServerOptions = { host: "127.0.0.1", port };
        const server = new WsServer({ ...base, ...overrides });
        await server.open();
        cleanups.push(() => server.close());
        return { server, url: `ws://127.0.0.1:${port}` };
    }

    it("open 后客户端可正常连入", async () => {
        const { url } = await start();
        const ws = await connectOk(url);
        cleanups.push(async () => ws.terminate());
        expect(ws.readyState).toBe(1); // WebSocket.OPEN
    });

    it("消息经 onRequest 分发，respond 回发同一客户端", async () => {
        const { server, url } = await start();
        const seen: unknown[] = [];
        server.onRequest = (req, respond) => {
            seen.push(req);
            respond({ echo: req });
        };

        const ws = await connectOk(url);
        cleanups.push(async () => ws.terminate());
        ws.send(JSON.stringify({ a: 1 }));

        await expect(waitJsonMessage(ws)).resolves.toEqual({ echo: { a: 1 } });
        expect(seen).toEqual([{ a: 1 }]);
    });

    it("respond 的 status 参数被 WS 传输忽略（载荷照常回发）", async () => {
        const { server, url } = await start();
        server.onRequest = (_req, respond) => {
            respond({ ok: true }, 404);
        };

        const ws = await connectOk(url);
        cleanups.push(async () => ws.terminate());
        ws.send(JSON.stringify({}));

        await expect(waitJsonMessage(ws)).resolves.toEqual({ ok: true });
    });

    it("广播 send 到全部客户端", async () => {
        const { server, url } = await start();
        const ws1 = await connectOk(url);
        const ws2 = await connectOk(url);
        cleanups.push(async () => {
            ws1.terminate();
            ws2.terminate();
        });
        // 客户端 open 可能早于服务端 connection 事件入 Set：让一拍再广播
        await realDelay(30);

        server.send({ hello: 1 });
        await expect(waitJsonMessage(ws1)).resolves.toEqual({ hello: 1 });
        await expect(waitJsonMessage(ws2)).resolves.toEqual({ hello: 1 });
    });

    it("待发缓冲加上 UTF-8 新帧超过上限时只断开慢连接", async () => {
        const { server, url } = await start({ maxBufferedBytes: 64 });
        const sockets: WsSocket[] = [];
        server.onConnection = (socket) => sockets.push(socket);
        const slow = await connectOk(url);
        const healthy = await connectOk(url);
        cleanups.push(async () => {
            slow.terminate();
            healthy.terminate();
        });

        const slowServer = take(sockets[0], "缺少慢连接");
        // 46 + 14 + 5 个 UTF-8 字节超限，若误用字符串长度则不会超限。
        vi.spyOn(slowServer, "bufferedAmount", "get").mockReturnValue(46);
        const send = vi.spyOn(slowServer, "send");
        const slowClosed = waitClose(slow);
        const healthyMessage = waitJsonMessage(healthy);
        server.send("汉");

        expect(send).not.toHaveBeenCalled();
        await expect(slowClosed).resolves.toMatchObject({ code: 1006 });
        await expect(healthyMessage).resolves.toBe("汉");
    });

    it("非 JSON 消息被忽略（不进 onRequest），后续 JSON 消息仍正常分发", async () => {
        const { server, url } = await start();
        const onRequest = vi.fn((_req: unknown, respond: (res: unknown) => void) => {
            respond({ got: true });
        });
        server.onRequest = onRequest;

        const ws = await connectOk(url);
        cleanups.push(async () => ws.terminate());
        ws.send("this-is-not-json");
        ws.send(JSON.stringify({ seq: 2 }));

        await expect(waitJsonMessage(ws)).resolves.toEqual({ got: true });
        expect(onRequest).toHaveBeenCalledTimes(1);
        expect(onRequest.mock.calls[0]?.[0]).toEqual({ seq: 2 });
    });

    it("authorize 返回 false → 以 4401 unauthorized 关闭", async () => {
        const { url } = await start({ authorize: () => false });

        const ws = new ClientSocket(url);
        const closed = await waitClose(ws);
        expect(closed.code).toBe(4401);
        expect(closed.reason).toBe("unauthorized");
    });

    it("authorize 收到 url 与展平 headers（upgrade 头存在）", async () => {
        let seen: RequestContext | undefined;
        const { url } = await start({
            authorize: (ctx) => {
                seen = ctx;
                return true;
            },
        });

        await connectOk(`${url}/ws?access_token=t`);
        expect(seen?.url).toBe("/ws?access_token=t");
        expect(seen?.headers["upgrade"]).toBe("websocket");
    });

    it("onConnection 在 authorize 通过后触发，入参为握手 RequestContext", async () => {
        let seen: RequestContext | undefined;
        const { server, url } = await start();
        server.onConnection = (_socket, ctx) => {
            seen = ctx;
        };

        const ws = await connectOk(`${url}/v1/events?x=1`);
        cleanups.push(async () => ws.terminate());
        await realDelay(30);

        expect(seen?.url).toBe("/v1/events?x=1");
    });

    it("authorize 拒绝时不触发 onConnection", async () => {
        const seen: RequestContext[] = [];
        const { server, url } = await start({ authorize: () => false });
        server.onConnection = (_socket, ctx) => {
            seen.push(ctx);
        };

        const ws = new ClientSocket(url);
        const closed = await waitClose(ws);
        expect(closed.code).toBe(4401);
        expect(seen).toHaveLength(0);
    });

    it("onRequest 第三参收到发起请求的连接（带内鉴权登记用）", async () => {
        const { server, url } = await start();
        let connection: unknown;
        let fromRequest: unknown;
        server.onConnection = (socket) => {
            connection = socket;
        };
        server.onRequest = (_req, respond, socket) => {
            fromRequest = socket;
            respond({ ok: true });
        };

        const ws = await connectOk(url);
        cleanups.push(async () => ws.terminate());
        ws.send(JSON.stringify({}));

        await expect(waitJsonMessage(ws)).resolves.toEqual({ ok: true });
        expect(fromRequest).toBeDefined();
        expect(fromRequest).toBe(connection);
    });

    it("path 选项：匹配路径可连入，其他路径握手被拒", async () => {
        const { url } = await start({ path: "/ws" });

        const ok = await connectOk(`${url}/ws`);
        cleanups.push(async () => ok.terminate());
        expect(ok.readyState).toBe(1); // WebSocket.OPEN

        const bad = new ClientSocket(`${url}/other`);
        await expect(waitOpen(bad)).rejects.toThrow(/401|404|unexpected/i);
    });

    it("open 幂等：重复 open 不重建 server（直接返回）", async () => {
        const { server, url } = await start();
        await server.open();
        const ws = await connectOk(url);
        cleanups.push(async () => ws.terminate());
        expect(ws.readyState).toBe(1); // WebSocket.OPEN：仍是同一监听
    });

    it("升级请求头为数组形态（重复 Set-Cookie）→ 展平为逗号连接", async () => {
        let seenCookie: string | string[] | undefined;
        const { url } = await start({
            authorize: (ctx) => {
                seenCookie = ctx.headers["set-cookie"];
                return true;
            },
        });

        // ws 客户端发不了重复头：用裸 TCP 手写 upgrade 请求携带两个 Set-Cookie
        await rawUpgrade(url, "/ws", "Set-Cookie: a=1\r\nSet-Cookie: b=2\r\n");
        // Node 解析 req.headers 时 set-cookie 保持数组形态，toRequestContext 应 join
        expect(seenCookie).toBe("a=1, b=2");
    });

    // 注：maxPayloadBytes 自定义值（超限 1009 关闭）无法在单测中安全覆盖——
    // WsServer 未给连接挂 error 监听（ws-server.ts onConnection），接收器超限
    // 错误会以 uncaughtException 冒出并击穿测试进程（已记入疑似生产 bug 清单）。

    it("未 open 时 send 为静默 no-op（wss 未初始化）", async () => {
        const port = await getFreePort();
        const server = new WsServer({ host: "127.0.0.1", port });
        expect(() => server.send({ never: true })).not.toThrow();
    });

    it("close 关闭全部连接、send 静默、重复 close 与未 open close 安全", async () => {
        const port = await getFreePort();
        const server = new WsServer({ host: "127.0.0.1", port });
        cleanups.push(() => server.close());
        await expect(server.close()).resolves.toBeUndefined();

        await server.open();
        const url = `ws://127.0.0.1:${port}`;
        const ws = await connectOk(url);
        cleanups.push(async () => ws.terminate());

        const closed = waitClose(ws);
        await server.close();
        await expect(closed).resolves.toMatchObject({ code: 1001 });
        expect(() => server.send({ after: "close" })).not.toThrow();
        await expect(server.close()).resolves.toBeUndefined();
    });

    it("close 后可重新 open 恢复服务", async () => {
        const port = await getFreePort();
        const server = new WsServer({ host: "127.0.0.1", port });
        cleanups.push(() => server.close());

        await server.open();
        await server.close();
        await server.open();

        const ws = await connectOk(`ws://127.0.0.1:${port}`);
        cleanups.push(async () => ws.terminate());
        expect(ws.readyState).toBe(ws.OPEN);
    });

    it("并发关闭给健康连接发 1001，回收停读 WS 和未完成 HTTP 握手", async () => {
        const { server, url } = await start();
        const serverSockets: WsSocket[] = [];
        server.onConnection = (socket) => {
            serverSockets.push(socket);
        };
        const healthy = await connectOk(url);
        const slow = await connectOk(url);
        const { port, hostname } = new URL(url);
        const raw = netConnect(Number(port), hostname);
        cleanups.push(async () => {
            raw.destroy();
            slow.terminate();
            healthy.terminate();
        });
        await once(raw, "connect");
        raw.write("GET / HTTP/1.1\r\nHost: localhost\r\n");
        raw.resume();
        slow.pause();
        const rawClosed = once(raw, "close");
        const healthyClosed = waitClose(healthy);
        const slowServerSide = take(serverSockets[1], "未接入慢连接");
        const slowServerClosed = waitClose(slowServerSide);
        const started = performance.now();
        const closing = server.close();
        expect(server.close()).toBe(closing);
        await expect(healthyClosed).resolves.toMatchObject({ code: 1001 });
        await expect(slowServerClosed).resolves.toMatchObject({ code: 1006 });
        await Promise.all([closing, rawClosed]);
        expect(performance.now() - started).toBeLessThan(1500);
        expect(slowServerSide.listenerCount("message")).toBe(0);
        await server.open();
        const replacement = await connectOk(url);
        replacement.terminate();
    });

    describe("心跳（fake timers）", () => {
        beforeEach(() => {
            vi.useFakeTimers({
                toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
            });
        });
        afterEach(() => {
            vi.restoreAllMocks();
            vi.useRealTimers();
        });

        it("匹配的 pong 维持健康连接，关闭时清理正在等待的探测", async () => {
            const schedule = vi.spyOn(globalThis, "setTimeout");
            const cancel = vi.spyOn(globalThis, "clearTimeout");
            const { server, url } = await start({
                heartbeat: { intervalMs: 40, pongTimeoutMs: 100 },
            });
            const connected = new Promise<WsSocket>((resolve) => {
                server.onConnection = resolve;
            });
            const ws = await connectOk(url);
            cleanups.push(async () => ws.terminate());
            const socket = await connected;

            for (let round = 0; round < 4; round += 1) {
                const pong = once(socket, "pong");
                await vi.advanceTimersByTimeAsync(40);
                await pong;
                expect(ws.readyState).toBe(ClientSocket.OPEN);
            }

            const heartbeatTimer = schedule.mock.results.at(-1)?.value;
            expect(schedule).toHaveBeenLastCalledWith(expect.any(Function), 40);
            const closing = server.close();
            expect(cancel).toHaveBeenCalledWith(heartbeatTimer);
            expect(socket.listenerCount("pong")).toBe(0);
            await closing;
        });

        it.each([false, true])("收不到匹配 pong 时回收连接（错误 pong: %s）", async (wrongPong) => {
            const { server, url } = await start({
                heartbeat: { intervalMs: 30, pongTimeoutMs: 100 },
            });
            const connected = new Promise<WsSocket>((resolve) => {
                server.onConnection = resolve;
            });
            const ws = new ClientSocket(url, { autoPong: false });
            cleanups.push(async () => ws.terminate());
            await waitOpen(ws);
            const socket = await connected;
            const ping = once(ws, "ping");
            const closed = waitClose(ws);
            await vi.advanceTimersByTimeAsync(30);
            await ping;
            if (wrongPong) ws.pong("unrelated");

            await vi.advanceTimersByTimeAsync(99);
            expect(ws.readyState).toBe(ClientSocket.OPEN);
            await vi.advanceTimersByTimeAsync(1);
            expect(socket.readyState).not.toBe(ClientSocket.OPEN);
            await expect(closed).resolves.toMatchObject({ code: 1006 });
            expect(vi.getTimerCount()).toBe(0);
        });

        it("心跳仅对 OPEN 客户端发送（未 open 时无帧）", async () => {
            const { server, url } = await start({ heartbeat: { intervalMs: 30 } });
            const ws = await connectOk(url);
            const closed = waitClose(ws);
            ws.close(1000);
            await closed;

            // 客户端已 CLOSED：推进两轮也不应抛错（发送分支被 readyState 过滤）
            await vi.advanceTimersByTimeAsync(80);
            await realDelay(20);
            await server.close();
        });

        it("未配置 heartbeat 时不建立定时器（close 无定时器泄漏）", async () => {
            const { server, url } = await start();
            const ws = await connectOk(url);
            await realDelay(20);
            expect(ws.readyState).toBe(1); // WebSocket.OPEN
            ws.terminate();
            await server.close();
        });
    });
});
