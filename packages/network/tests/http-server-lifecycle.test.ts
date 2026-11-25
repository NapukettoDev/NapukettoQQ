import { connect } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { HttpServer } from "../src/http-server.js";
import { createSseResponse } from "../src/sse.js";
import type { Respond } from "../src/types.js";
import { getFreePort, realDelay, waitClose, waitOpen } from "./test-support.js";

describe("HttpServer 有界回收（真实端口）", () => {
    const cleanup: Array<() => void | Promise<void>> = [];
    afterEach(async () => {
        for (const close of cleanup.splice(0).reverse()) await close();
    });

    async function start(timeoutMs?: number) {
        const port = await getFreePort();
        const server = new HttpServer({ host: "127.0.0.1", port, timeoutMs });
        cleanup.push(() => server.close());
        return { server, port, base: `http://127.0.0.1:${port}` };
    }

    it("活跃 SSE 不受普通超时影响，关闭取消流、释放 WS 与等待 respond 的请求", async () => {
        const { server, port, base } = await start(100);
        const unsubscribe = vi.fn();
        let reply: Respond | undefined;
        const entered = Promise.withResolvers<void>();
        server.onRawRequest = () => createSseResponse(() => unsubscribe);
        server.onUpgrade = (_req, accept) => accept(() => undefined);
        await server.open();
        const controller = new AbortController();
        cleanup.push(() => controller.abort());
        const sse = await fetch(`${base}/stream`, { signal: controller.signal });
        const reader = sse.body?.getReader();
        const streamEnded = reader?.read().then(
            () => undefined,
            () => undefined,
        );
        await realDelay(150);
        expect(unsubscribe).not.toHaveBeenCalled();
        server.onRawRequest = () => undefined;
        server.onRequest = (_req, respond) => {
            reply = respond;
            entered.resolve();
        };
        const ws = new WebSocket(`${base.replace("http", "ws")}/ws`);
        cleanup.push(() => ws.terminate());
        await waitOpen(ws);
        const closed = waitClose(ws);
        const request = fetch(`${base}/api`, { method: "POST", body: "{}" });
        await entered.promise;
        await Promise.all([server.close(), server.close()]);
        expect((await closed).code).toBe(1001);
        const res = await request;
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ error: "server shutdown" });
        await streamEnded;
        await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce());
        const toJSON = vi.fn(() => {
            throw new Error("late response");
        });
        expect(() => reply?.({ toJSON })).not.toThrow();
        expect(toJSON).not.toHaveBeenCalled();
        const replacement = new HttpServer({ host: "127.0.0.1", port });
        cleanup.push(() => replacement.close());
        await replacement.open();
    });

    it("未回应关闭握手的 WS、未完成请求体和未承接升级也在宽限期后释放", async () => {
        const { server, base } = await start();
        const upgraded = Promise.withResolvers<void>();
        server.onUpgrade = (req, accept) => {
            if (req.url === "/ws") accept(() => undefined);
            else upgraded.resolve();
        };
        await server.open();
        const ws = new WebSocket(`${base.replace("http", "ws")}/ws`);
        cleanup.push(() => ws.terminate());
        await waitOpen(ws);
        ws.pause(); // 不读关闭帧，因此不会回关闭握手。
        const wsClosed = waitClose(ws);
        const url = new URL(base);
        const upload = connect(Number(url.port), url.hostname);
        const upgrade = connect(Number(url.port), url.hostname);
        cleanup.push(() => {
            upload.destroy();
            upgrade.destroy();
        });
        upload.on("error", () => undefined);
        upgrade.on("error", () => undefined);
        upload.write("POST /api HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\n{");
        upgrade.write(
            "GET /ignored HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
        );
        upload.resume();
        upgrade.resume();
        const tcpClosed = Promise.all([
            new Promise<void>((resolve) => upload.once("close", () => resolve())),
            new Promise<void>((resolve) => upgrade.once("close", () => resolve())),
        ]);
        await upgraded.promise;
        await server.close();
        await tcpClosed;
        ws.resume();
        await wsClosed;
        await server.open();
    }, 2000);

    it("客户端断开会释放无超时请求，迟到 respond 忽略", async () => {
        const { server, base } = await start();
        const entered = Promise.withResolvers<Respond>();
        server.onRequest = (_req, respond) => entered.resolve(respond);
        await server.open();
        const controller = new AbortController();
        const request = fetch(`${base}/api`, {
            method: "POST",
            body: "{}",
            signal: controller.signal,
        }).catch(() => undefined);
        const reply = await entered.promise;
        controller.abort();
        await request;
        // 真实 I/O 完成后再调用迟到回调；不用内部字段判断资源释放。
        await realDelay(30);
        const toJSON = vi.fn(() => {
            throw new Error("aborted response");
        });
        reply({ toJSON });
        expect(toJSON).not.toHaveBeenCalled();
        await server.close();
    });
});
