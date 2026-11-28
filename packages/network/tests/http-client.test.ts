/**
 * HttpClient（正向 HTTP 事件上报）测试
 *
 * 真实 127.0.0.1 临时端口端到端：node:http 桩服务记录请求。
 * 锁定：POST JSON + 默认 Content-Type、自定义头合并（可覆盖默认）、
 * 2xx 静默、非 2xx → onError、连接拒绝 → onError、超时 → onError、
 * fire-and-forget 语义（send 同步提交、投递失败异步回调）。
 */
import {
    createServer,
    type IncomingHttpHeaders,
    type IncomingMessage,
    type Server,
    type ServerResponse,
} from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../src/http-client.js";

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
    const clients: HttpClient[] = [];
    afterEach(async () => {
        for (const client of clients.splice(0)) await client.close();
        for (const stub of stubs.reverse()) {
            await stub.close();
        }
        stubs.length = 0;
    });

    function makeClient(opts: ConstructorParameters<typeof HttpClient>[0]): HttpClient {
        const client = new HttpClient(opts);
        clients.push(client);
        return client;
    }

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

    it.each([200, 503])("收到 %i 后取消无终点的响应体", async (status) => {
        const closed = Promise.withResolvers<void>();
        const stub = await serve((_req, res) => {
            res.once("close", closed.resolve);
            res.writeHead(status).write("still streaming");
        });
        const onError = vi.fn();
        const client = makeClient({ url: stub.url, onError });
        client.send({ ping: 1 });
        await closed.promise;
        if (status === 200) {
            expect(onError).not.toHaveBeenCalled();
        } else {
            expect(onError.mock.calls.map(([error]) => String(error))).toEqual([
                expect.stringContaining("503"),
            ]);
        }
    });

    it("慢端点保留一条在途与 64 条等待，拒收新事件并按序投递", async () => {
        const first = Promise.withResolvers<ServerResponse>();
        const slow = await serve((_req, res, body) => {
            if (body === "0") first.resolve(res);
            else res.end();
        });
        const fast = await serve((_req, res) => res.end());
        const onError = vi.fn();
        const client = makeClient({ url: slow.url, onError });
        const other = makeClient({ url: fast.url });
        for (let i = 0; i < 66; i += 1) client.send(i);
        other.send("other destination");
        const active = await first.promise;
        await vi.waitFor(() => expect(fast.requests).toHaveLength(1));
        expect(slow.requests.map((req) => req.body)).toEqual(["0"]);
        expect(onError.mock.calls.map(([error]) => String(error))).toEqual([
            expect.stringContaining("队列已满"),
        ]);
        active.end();
        await vi.waitFor(() => expect(slow.requests).toHaveLength(65), { timeout: 2500 });
        expect(slow.requests.map((req) => req.body)).toEqual(
            Array.from({ length: 65 }, (_, i) => String(i)),
        );
    });

    it("超出待发送正文预算的事件在本地拒收", async () => {
        const stub = await serve((_req, res) => res.end());
        const onError = vi.fn();
        const client = makeClient({ url: stub.url, onError });
        client.send("x".repeat(32 * 1024 * 1024));
        expect(onError.mock.calls.map(([error]) => String(error))).toEqual([
            expect.stringContaining("正文超限"),
        ]);
        client.send("next");
        await vi.waitFor(() => expect(stub.requests.map((req) => req.body)).toEqual(['"next"']));
    });

    it("过期事件在出队时回报超时，没有发起请求", async () => {
        const first = Promise.withResolvers<ServerResponse>();
        const expired = Promise.withResolvers<unknown>();
        const stub = await serve((_req, res) => first.resolve(res));
        const now = vi.spyOn(performance, "now").mockReturnValue(0);
        try {
            const client = makeClient({ url: stub.url, onError: expired.resolve });
            client.send("active");
            client.send("queued");
            const res = await first.promise;
            now.mockReturnValue(5_000);
            res.end();
            await expect(expired.promise).resolves.toMatchObject({ name: "TimeoutError" });
            expect(stub.requests.map((req) => req.body)).toEqual(['"active"']);
        } finally {
            now.mockRestore();
        }
    });

    it("关闭取消在途并丢弃队列，重开只投递新事件", async () => {
        const entered = Promise.withResolvers<void>();
        const closed = Promise.withResolvers<void>();
        const stub = await serve((_req, res, body) => {
            if (body !== "1") {
                res.end();
                return;
            }
            res.once("close", closed.resolve);
            entered.resolve();
        });
        const onError = vi.fn();
        const client = makeClient({ url: stub.url, onError });
        client.send(1);
        client.send(2);
        await entered.promise;
        await Promise.all([client.close(), client.close(), closed.promise]);
        client.send(3);
        expect(onError.mock.calls.map(([error]) => String(error))).toEqual([
            expect.stringContaining("上报已关闭"),
        ]);
        await client.open();
        client.send(4);
        await vi.waitFor(() => expect(stub.requests.map((req) => req.body)).toEqual(["1", "4"]));
    });
});
