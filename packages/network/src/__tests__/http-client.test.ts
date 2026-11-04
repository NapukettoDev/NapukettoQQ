/**
 * HttpClient（正向 HTTP 事件上报）测试
 *
 * 真实 127.0.0.1 临时端口端到端：node:http 桩服务记录请求。
 * 锁定：POST JSON + 默认 Content-Type、自定义头合并（可覆盖默认）、
 * 2xx 静默、非 2xx → onError、连接拒绝 → onError、超时 → onError、
 * fire-and-forget 语义（send 同步返回、失败异步回调）、open/close no-op。
 */
import {
    createServer,
    type IncomingHttpHeaders,
    type IncomingMessage,
    type Server,
    type ServerResponse,
} from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../http-client.js";

/** 桩服务记录到的一条请求。 */
interface RecordedRequest {
    method: string;
    url: string;
    headers: IncomingHttpHeaders;
    body: string;
}

interface HttpStub {
    port: number;
    url: string;
    requests: RecordedRequest[];
    close: () => Promise<void>;
}

/** 起一个记录请求的本地 HTTP 桩（响应行为由 respond 注入）。 */
function startStub(
    respond: (req: IncomingMessage, res: ServerResponse, body: string) => void,
): Promise<HttpStub> {
    return new Promise((resolve, reject) => {
        const requests: RecordedRequest[] = [];
        const server: Server = createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (chunk: Buffer) => {
                chunks.push(chunk);
            });
            req.on("end", () => {
                const body = Buffer.concat(chunks).toString();
                requests.push({
                    method: req.method ?? "",
                    url: req.url ?? "",
                    headers: req.headers,
                    body,
                });
                respond(req, res, body);
            });
        });
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address();
            if (addr === null || typeof addr === "string") {
                reject(new Error("未取得临时端口"));
                return;
            }
            resolve({
                port: addr.port,
                url: `http://127.0.0.1:${addr.port}`,
                requests,
                close: () =>
                    new Promise<void>((done) => {
                        server.closeAllConnections();
                        server.close(() => done());
                    }),
            });
        });
    });
}

describe("HttpClient", () => {
    const stubs: HttpStub[] = [];
    afterEach(async () => {
        for (const stub of stubs.reverse()) {
            await stub.close();
        }
        stubs.length = 0;
    });

    /** 起桩并登记到 afterEach 清理列表。 */
    async function serve(
        respond: (req: IncomingMessage, res: ServerResponse, body: string) => void,
    ): Promise<HttpStub> {
        const stub = await startStub(respond);
        stubs.push(stub);
        return stub;
    }

    /** send 一次并等待 onError 回调（onError 构造时注入，fire-and-forget）。 */
    function sendAwaitError(url: string, payload: unknown, timeoutMs?: number): Promise<unknown> {
        return new Promise((resolve) => {
            const client =
                timeoutMs === undefined
                    ? new HttpClient({ url, onError: resolve })
                    : new HttpClient({ url, timeoutMs, onError: resolve });
            client.send(payload);
        });
    }

    it("send 触发一次 POST：JSON body + 默认 content-type，2xx 不回调 onError", async () => {
        const stub = await serve((_req, res) => {
            res.statusCode = 200;
            res.end("ok");
        });
        const onError = vi.fn();
        const client = new HttpClient({ url: stub.url, onError });

        client.send({ type: "message", data: 1 });
        await vi.waitFor(() => expect(stub.requests).toHaveLength(1));

        const req = stub.requests[0];
        expect(req?.method).toBe("POST");
        expect(req?.url).toBe("/");
        expect(req?.headers["content-type"]).toBe("application/json");
        expect(JSON.parse(req?.body ?? "{}")).toEqual({ type: "message", data: 1 });
        expect(onError).not.toHaveBeenCalled();
    });

    it("自定义 headers 与默认头合并（content-type 可被覆盖）", async () => {
        const stub = await serve((_req, res) => {
            res.end("ok");
        });
        const client = new HttpClient({
            url: stub.url,
            headers: { authorization: "Bearer t0ken", "content-type": "text/x-custom" },
        });

        client.send({});
        await vi.waitFor(() => expect(stub.requests).toHaveLength(1));

        const req = stub.requests[0];
        expect(req?.headers["authorization"]).toBe("Bearer t0ken");
        expect(req?.headers["content-type"]).toBe("text/x-custom");
    });

    it("非 2xx（500）→ onError 收到含状态码的错误", async () => {
        const stub = await serve((_req, res) => {
            res.statusCode = 500;
            res.end("boom");
        });
        const err = await sendAwaitError(stub.url, {});

        expect(err instanceof Error).toBe(true);
        expect(String(err)).toContain("500");
    });

    it("连接拒绝（无服务）→ onError 收到 fetch failed", async () => {
        // 占坑后立即释放的端口：紧随其后的连接会 ECONNREFUSED
        const probe = await startStub(() => undefined);
        const { url } = probe;
        await probe.close();

        const err = await sendAwaitError(url, {});
        expect(String(err)).toContain("fetch failed");
    });

    it("超时 → onError 收到超时中止错误（挂起的服务端不响应）", async () => {
        const stub = await serve(() => {
            // 故意不响应（挂起），由客户端超时中止
        });
        const err = await sendAwaitError(stub.url, {}, 60);
        expect(String(err).toLowerCase()).toMatch(/abort|timeout/);
    });

    it("多次 send → 每次都产生一次独立上报", async () => {
        const stub = await serve((_req, res) => {
            res.end("ok");
        });
        const client = new HttpClient({ url: stub.url });
        client.send({ n: 1 });
        client.send({ n: 2 });
        await vi.waitFor(() => expect(stub.requests).toHaveLength(2));
        expect(JSON.parse(stub.requests[1]?.body ?? "{}")).toEqual({ n: 2 });
    });

    it("open / close 为无连接管理语义（no-op，不抛错）", async () => {
        const stub = await serve((_req, res) => {
            res.end("ok");
        });
        const client = new HttpClient({ url: stub.url });
        expect(() => client.open()).not.toThrow();
        expect(() => client.close()).not.toThrow();
        expect(() => client.send({ after: "close" })).not.toThrow();
    });
});
