/**
 * HttpServer（反向 HTTP server）分支补漏测试
 *
 * 真实 127.0.0.1 临时端口端到端（每用例独立起服）。
 * 覆盖基线未触达的分支：鉴权 401（含钩子入参）、非法 JSON 400、
 * GET 无 body 400、请求体上限 413、respond 自定义 status、respond(undefined)
 * 空 body、onPathRequest 优先于 onRequest、onRawRequest 短路/放行、
 * open/close 幂等、send no-op、onUpgrade reject 与升级上下文。
 *
 * 注意：onUpgrade 必须在 open() 之前挂（open 时才 attach upgrade 监听），
 * 注入点统一经 start(configure) 在 open 前配置。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { HttpServer } from "../http-server.js";
import type { HttpServerOptions, RequestContext } from "../types.js";
import { getFreePort, waitOpen } from "./test-support.js";

describe("HttpServer", () => {
    const servers: HttpServer[] = [];
    afterEach(async () => {
        // 先取走再逐个关闭：单个 close 异常不污染下一用例的清理列表。
        const pending = servers.splice(0).reverse();
        for (const server of pending) {
            // 强断全部连接（含 keep-alive / 在途请求），避免 close 因活动 socket 挂起。
            const raw = server as unknown as { closeAllConnections?: () => void };
            raw.closeAllConnections?.();
            await server.close();
        }
    });

    /** 起一个 HttpServer：configure 在 open 之前执行（升级钩子须先挂）。 */
    async function start(
        configure?: (server: HttpServer) => void,
        overrides: Partial<HttpServerOptions> = {},
    ): Promise<{ server: HttpServer; base: string }> {
        const port = await getFreePort();
        const base: HttpServerOptions = { host: "127.0.0.1", port };
        const server = new HttpServer({ ...base, ...overrides });
        configure?.(server);
        await server.open();
        servers.push(server);
        return { server, base: `http://127.0.0.1:${port}` };
    }

    it("POST JSON → onRequest 分发并按默认 200 回 JSON", async () => {
        const { base } = await start((server) => {
            server.onRequest = (req, respond) => {
                respond({ echo: req });
            };
        });

        const res = await fetch(`${base}/api`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ a: 1 }),
        });
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("application/json");
        expect(await res.json()).toEqual({ echo: { a: 1 } });
    });

    it("respond 带自定义 status（404）→ 状态码透传、body 保留 JSON", async () => {
        const { base } = await start((server) => {
            server.onRequest = (_req, respond) => {
                respond({ error: "not found" }, 404);
            };
        });

        const res = await fetch(`${base}/x`, { method: "POST", body: "{}" });
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: "not found" });
    });

    it("respond(undefined) → 无 body 响应，status 缺省 200", async () => {
        const { base } = await start((server) => {
            server.onRequest = (_req, respond) => {
                respond(undefined);
            };
        });

        const res = await fetch(`${base}/x`, { method: "POST", body: "{}" });
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("");
    });

    it("onPathRequest 分发 respond(undefined, 204) → 204 空 body", async () => {
        const { base } = await start((server) => {
            server.onPathRequest = (_ctx, _req, respond) => {
                respond(undefined, 204);
            };
        });

        const res = await fetch(`${base}/v1/noop`, { method: "POST", body: "{}" });
        expect(res.status).toBe(204);
        expect(await res.text()).toBe("");
    });

    it("authorize 返回 false → 401 {error: unauthorized}", async () => {
        const { base } = await start(
            (server) => {
                server.onRequest = (_req, respond) => {
                    respond({ never: true });
                };
            },
            { authorize: () => false },
        );

        const res = await fetch(`${base}/api`, { method: "POST", body: "{}" });
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: "unauthorized" });
    });

    it("authorize 收到 url（含查询串）与展平的 headers", async () => {
        let seen: RequestContext | undefined;
        const { base } = await start(
            (server) => {
                server.onRequest = (_req, respond) => {
                    respond({ ok: true });
                };
            },
            {
                authorize: (ctx) => {
                    seen = ctx;
                    return true;
                },
            },
        );

        await fetch(`${base}/api?token=abc`, { method: "POST", body: "{}" });
        expect(seen?.url).toContain("/api?token=abc");
        expect(seen?.headers["content-type"]).toBeDefined();
    });

    it("非法 JSON body → 400 {error: invalid json body}", async () => {
        const { server, base } = await start();
        const onRequest = vi.fn();
        server.onRequest = onRequest;

        const res = await fetch(`${base}/api`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{not-json",
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "invalid json body" });
        expect(onRequest).not.toHaveBeenCalled();
    });

    it("GET 无 body → 同样落入 400（JSON 解析失败分支与方法无关）", async () => {
        const { server, base } = await start();
        const onRequest = vi.fn();
        server.onRequest = onRequest;

        const res = await fetch(`${base}/api`);
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "invalid json body" });
        expect(onRequest).not.toHaveBeenCalled();
    });

    it("超过 bodyLimitBytes → 413 {error: payload too large}", async () => {
        const { base } = await start(undefined, { bodyLimitBytes: 64 });

        const res = await fetch(`${base}/api`, { method: "POST", body: "x".repeat(200) });
        expect(res.status).toBe(413);
        expect(await res.json()).toEqual({ error: "payload too large" });
    });

    it("onPathRequest 设置时优先于 onRequest（整机入口不触发）", async () => {
        const { base } = await start((server) => {
            const whole = vi.fn();
            server.onRequest = whole;
            server.onPathRequest = (ctx, req, respond) => {
                expect(ctx.path).toBe("/rpc/message.create");
                expect(ctx.method).toBe("POST");
                expect(req).toEqual({ q: 1 });
                respond({ via: "path" });
            };
        });

        const res = await fetch(`${base}/rpc/message.create`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ q: 1 }),
        });
        expect(await res.json()).toEqual({ via: "path" });
    });

    it("onRawRequest 返回 Response → 短路（不解析 JSON、不走 onRequest）", async () => {
        const { base } = await start((server) => {
            const whole = vi.fn();
            server.onRequest = whole;
            server.onRawRequest = (ctx) => {
                if (ctx.path === "/stream") {
                    return new Response("raw-data", {
                        status: 200,
                        headers: { "content-type": "text/plain" },
                    });
                }
                return undefined;
            };
        });

        const res = await fetch(`${base}/stream`, { method: "POST", body: "anything" });
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/plain");
        expect(await res.text()).toBe("raw-data");
    });

    it("onRawRequest 返回 undefined → 继续常规 JSON 流程", async () => {
        const { base } = await start((server) => {
            server.onRequest = (req, respond) => {
                respond({ fell: "through", req });
            };
            server.onRawRequest = () => undefined;
        });

        const res = await fetch(`${base}/api`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ z: 9 }),
        });
        expect(await res.json()).toEqual({ fell: "through", req: { z: 9 } });
    });

    it("send 为 no-op（HTTP 反向无主动推送）", async () => {
        const { server } = await start();
        expect(() => server.send({ any: 1 })).not.toThrow();
    });

    it("open 幂等、close 幂等、未 open 直接 close 安全", async () => {
        const port = await getFreePort();
        const base: HttpServerOptions = { host: "127.0.0.1", port };
        const server = new HttpServer(base);
        await server.close();

        await server.open();
        await server.open();
        await server.close();
        await server.close();
    });

    it("onUpgrade reject(status) → WS 握手以该状态码被拒", async () => {
        const { base } = await start((server) => {
            server.onUpgrade = (_req, _accept, reject) => {
                reject(403, "forbidden");
            };
        });

        const ws = new WebSocket(`${base.replace("http", "ws")}/ws`);
        await expect(waitOpen(ws)).rejects.toThrow(/403/);
        ws.terminate();
    });

    it("onUpgrade 收到含查询串的 url 与升级头（accept 建立连接）", async () => {
        let seenUrl: string | undefined;
        let seenUpgrade: string | undefined;
        const { base } = await start((server) => {
            server.onUpgrade = (req, accept) => {
                seenUrl = req.url;
                seenUpgrade = req.headers["upgrade"];
                accept(() => undefined);
            };
        });

        const ws = new WebSocket(`${base.replace("http", "ws")}/event?access_token=x`);
        await waitOpen(ws);
        expect(seenUrl).toContain("/event?access_token=x");
        expect(seenUpgrade).toBe("websocket");
        ws.terminate();
    });
});
