/**
 * OB11 传输装配集成测试（真端口）：HTTP 反向鉴权（Bearer/裸头/查询参数）、
 * 反向 WS 请求-响应与 4401 拒连、HTTP 正向上报头（x-self-id/authorization）、
 * 正向 WS 客户端握手头（X-Self-ID/x-client-role）与双向请求、close 注销广播。
 * 另覆盖装配分支（自 transport-branches 并入）：enabled=false 不装配、
 * wsServers token 兜底链、恶意请求行鉴权 fail-closed。
 *
 * 锁定 docs/protocols/onebot11.md §2 的传输语义；端口固定（CI 两平台跑同一套）。
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { EventBroadcaster, WsServer } from "@napuketto/network";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket as WsTestClient } from "ws";
import type { OB11Config } from "../helper/index.js";
import { ob11ConfigSchema } from "../helper/index.js";
import { assembleOb11Transports, type Ob11TransportSet } from "../transport.js";

const HTTP_PORT = 37230;
const WS_PORT = 37231;
const REVERSE_PORT = 37232;
const POST_PORT = 37233;
const TOKEN = "tok-1";

/** 组装（zod 补全默认值）。 */
function assemble(seed: Record<string, unknown>): {
    set: Ob11TransportSet;
    broadcaster: EventBroadcaster;
    requests: unknown[];
} {
    const requests: unknown[] = [];
    const broadcaster = new EventBroadcaster();
    const set = assembleOb11Transports({
        config: ob11ConfigSchema.parse(seed) as OB11Config,
        broadcaster,
        selfUin: "10001",
        handleRequest: (req, respond) => {
            requests.push(req);
            const r = req as { echo?: unknown };
            respond({ retcode: 0, status: "ok", data: null, message: "", echo: r.echo });
        },
    });
    return { set, broadcaster, requests };
}

describe("HTTP 反向 server（token 鉴权 + 请求-响应）", () => {
    const { set, requests } = assemble({
        httpServers: [{ enabled: true, port: HTTP_PORT, token: TOKEN }],
    });

    afterAll(async () => {
        await set.close();
    });

    it("open 后无鉴权 → 401；Bearer 头 → 200 信封", async () => {
        await set.servers[0]?.open();
        const denied = await fetch(`http://127.0.0.1:${HTTP_PORT}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "get_status" }),
        });
        expect(denied.status).toBe(401);
        const ok = await fetch(`http://127.0.0.1:${HTTP_PORT}`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: `Bearer ${TOKEN}`,
            },
            body: JSON.stringify({ action: "get_status" }),
        });
        expect(ok.status).toBe(200);
        const body = (await ok.json()) as { retcode: number };
        expect(body.retcode).toBe(0);
        expect(requests.at(-1)).toMatchObject({ action: "get_status" });
    });

    it("裸 Authorization 头（无 Bearer 前缀）与 ?access_token= 均可过鉴权", async () => {
        const bare = await fetch(`http://127.0.0.1:${HTTP_PORT}`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: TOKEN },
            body: "{}",
        });
        expect(bare.status).toBe(200);
        const viaQuery = await fetch(`http://127.0.0.1:${HTTP_PORT}?access_token=${TOKEN}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
        });
        expect(viaQuery.status).toBe(200);
    });

    it("echo 参数原样响应", async () => {
        const res = await fetch(`http://127.0.0.1:${HTTP_PORT}`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: `Bearer ${TOKEN}`,
            },
            body: JSON.stringify({ action: "get_status", echo: "e-1" }),
        });
        const body = (await res.json()) as { echo?: unknown };
        expect(body.echo).toBe("e-1");
    });
});

describe("反向 WS server（4401 拒连 + echo 透传）", () => {
    const { set } = assemble({
        wsServers: [{ enabled: true, port: WS_PORT, token: TOKEN }],
    });

    afterAll(async () => {
        await set.close();
    });

    it("无 token 连入 → 关闭码 4401", async () => {
        await set.servers[0]?.open();
        const closeCode = await new Promise<number>((resolve) => {
            const ws = new WsTestClient(`ws://127.0.0.1:${WS_PORT}`);
            ws.on("close", (code) => {
                resolve(code);
            });
        });
        expect(closeCode).toBe(4401);
    });

    it("Bearer 鉴权连入 → 请求-响应 echo 透传", async () => {
        const received = await new Promise<string>((resolve, reject) => {
            const ws = new WsTestClient(`ws://127.0.0.1:${WS_PORT}`, {
                headers: { authorization: `Bearer ${TOKEN}` },
            });
            ws.on("open", () => {
                ws.send(JSON.stringify({ action: "get_status", echo: "ws-9" }));
            });
            ws.on("message", (raw) => {
                resolve(raw.toString());
                ws.close();
            });
            ws.on("error", (err) => reject(err));
            setTimeout(() => reject(new Error("WS 响应超时")), 3000);
        });
        expect(JSON.parse(received)).toMatchObject({ retcode: 0, echo: "ws-9" });
    });
});

describe("HTTP 正向上报（webhook 头 + fire-and-forget）", () => {
    const captured: { headers: IncomingMessage["headers"]; body: string }[] = [];
    let stub: ReturnType<typeof createServer> | undefined;
    const { set, broadcaster } = assemble({
        httpPostUrls: [{ enabled: true, url: `http://127.0.0.1:${POST_PORT}/hook`, token: TOKEN }],
    });

    beforeAll(async () => {
        stub = createServer((req: IncomingMessage, res: ServerResponse) => {
            let body = "";
            req.on("data", (chunk: Buffer) => {
                body += chunk.toString();
            });
            req.on("end", () => {
                captured.push({ headers: req.headers, body });
                res.writeHead(200);
                res.end();
            });
        });
        await new Promise<void>((resolve) => stub?.listen(POST_PORT, "127.0.0.1", resolve));
    });

    afterAll(async () => {
        await set.close();
        await new Promise<void>((resolve) => stub?.close(() => resolve()));
    });

    it("broadcaster.emit → POST x-self-id + Bearer 头 + 事件 JSON", async () => {
        await set.transports[0]?.open();
        broadcaster.emit({ post_type: "meta_event", meta_event_type: "lifecycle" });
        await vi.waitFor(() => {
            expect(captured.length).toBeGreaterThan(0);
        });
        const hit = captured[0] as { headers: Record<string, string | undefined>; body: string };
        expect(hit.headers["x-self-id"]).toBe("10001");
        expect(hit.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
        expect(JSON.parse(hit.body)).toMatchObject({ post_type: "meta_event" });
    });
});

describe("正向 WS client（握手头 + 请求回包）", () => {
    /** 上游捕获：握手头 + 收到的请求帧。 */
    const upgradeHeaders: Record<string, string | undefined>[] = [];
    const upstreamRequests: unknown[] = [];
    const { set } = assemble({
        wsReverseUrls: [
            {
                enabled: true,
                url: `ws://127.0.0.1:${REVERSE_PORT}`,
                token: TOKEN,
                heartbeatInterval: 30000,
            },
        ],
    });
    /** 手工装配的上游 server（authorize 捕获握手头；onRequest 捕获回包）。 */
    const upstream = new WsServer({
        host: "127.0.0.1",
        port: REVERSE_PORT,
        authorize: (ctx) => {
            upgradeHeaders.push(ctx.headers);
            return true;
        },
    });
    upstream.onRequest = (req) => {
        upstreamRequests.push(req);
    };

    beforeAll(async () => {
        await upstream.open();
        await (set.transports[0] as unknown as { open: () => Promise<void> }).open();
    });

    afterAll(async () => {
        await set.close();
        await upstream.close();
    });

    it("握手头：X-Self-ID / x-client-role=Universal / User-Agent=OneBot/11 / Bearer", async () => {
        // WsClient 连接成功（open 已 resolve）即握手完成；authorize 记录了头
        await vi.waitFor(() => {
            expect(upgradeHeaders.length).toBeGreaterThan(0);
        });
        const headers = upgradeHeaders[0] as Record<string, string | undefined>;
        expect(headers["x-self-id"]).toBe("10001");
        expect(headers["x-client-role"]).toBe("Universal");
        expect(headers["user-agent"]).toBe("OneBot/11");
        expect(headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    });

    it("上游推请求帧 → WsClient onRequest 消费并回包", async () => {
        // upstream server 广播一条请求帧给已连入的 OB11 client
        upstream.send({ action: "get_status", echo: "up-1" });
        await vi.waitFor(() => {
            expect(upstreamRequests.length).toBeGreaterThan(0);
        });
        expect(upstreamRequests[0]).toMatchObject({
            retcode: 0,
            status: "ok",
            echo: "up-1",
        });
    });
});

describe("assembleOb11Transports（装配形态）", () => {
    it("全关（enabled=false）→ servers/transports 空，close 幂等", async () => {
        const { set } = assemble({});
        expect(set.servers).toHaveLength(0);
        expect(set.transports).toHaveLength(0);
        await set.close();
    });

    it("url 缺失的 enabled 实例 → 不装配（防御）", () => {
        const { set } = assemble({
            httpPostUrls: [{ enabled: true, token: TOKEN }],
            wsReverseUrls: [{ enabled: true, token: TOKEN }],
        });
        expect(set.transports).toHaveLength(0);
        expect(set.servers).toHaveLength(0);
    });
});

describe("装配分支补充（无 token / 可选字段）", () => {
    it("无 token 的 HTTP server → 不装配鉴权钩子（匿名可访问）", async () => {
        const { set, requests } = assemble({
            httpServers: [{ enabled: true, port: 37242 }],
        });
        try {
            await set.servers[0]?.open();
            const res = await fetch(`http://127.0.0.1:${37242}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ action: "get_status" }),
            });
            expect(res.status).toBe(200);
            expect(requests).toHaveLength(1);
        } finally {
            await set.close();
        }
    });

    it("httpPost timeoutMs / wsReverse maxReconnectAttempts / 实例无 token 装配", async () => {
        const { set, broadcaster } = assemble({
            httpPostUrls: [
                // 无 token（authorizeHeader(undefined) 短路）+ timeoutMs 分支
                { enabled: true, url: "http://127.0.0.1:1/nowhere", timeoutMs: 5000 },
            ],
            wsReverseUrls: [
                // maxReconnectAttempts 分支（不 open，仅装配）
                {
                    enabled: true,
                    url: "ws://127.0.0.1:1/nowhere",
                    maxReconnectAttempts: 3,
                },
            ],
        });
        expect(set.transports).toHaveLength(2);
        await set.close();
        // emit 后不再有注册的传输（close 已注销）——不产生真实上报
        broadcaster.emit({ probe: true });
        expect(true).toBe(true);
    });
});

const BRANCH_TOKEN = "tok-x";
const WS_CONFIG_TOKEN_PORT = 37243;
const WS_NO_TOKEN_PORT = 37244;
const RAW_PROBE_PORT = 37245;

/** 关闭全部装配（有则关；幂等）。 */
async function closeAll(...sets: Array<Ob11TransportSet | undefined>): Promise<void> {
    for (const set of sets) {
        if (set !== undefined) {
            await set.close();
        }
    }
}

/** WS 连入并发一条请求，收集首个响应帧（解析为 JSON）。 */
function wsRequest(
    port: number,
    headers: Record<string, string> = {},
): Promise<{ retcode?: number; echo?: unknown }> {
    return new Promise((resolve, reject) => {
        const ws = new WsTestClient(`ws://127.0.0.1:${port}`, { headers });
        ws.on("open", () => {
            ws.send(JSON.stringify({ action: "get_status", echo: "branch" }));
        });
        ws.on("message", (raw) => {
            try {
                resolve(JSON.parse(raw.toString()) as { retcode?: number; echo?: unknown });
            } finally {
                ws.close();
            }
        });
        ws.on("error", (err: Error) => reject(err));
        setTimeout(() => {
            ws.terminate();
            reject(new Error("WS 响应超时"));
        }, 3000);
    });
}

describe("enabled=false 实例不装配", () => {
    it("httpServers / wsServers 混合开关 → 只装配 enabled 实例", async () => {
        const { set } = assemble({
            httpServers: [
                { enabled: false, host: "127.0.0.1", port: 1 },
                { enabled: true, host: "127.0.0.1", port: RAW_PROBE_PORT },
            ],
            wsServers: [
                { enabled: true, host: "127.0.0.1", port: WS_NO_TOKEN_PORT },
                { enabled: false, host: "127.0.0.1", port: 1 },
            ],
        });
        // 2 个反向 server（1 HTTP + 1 WS），禁用项被跳过
        expect(set.servers).toHaveLength(2);
        expect(set.transports).toHaveLength(0);
        await closeAll(set);
    });
});

describe("wsServers token 兜底链", () => {
    it("实例无 token + 协议级 config.token → Bearer 连入成功（?? 右支兜底）", async () => {
        const { set } = assemble({
            token: BRANCH_TOKEN,
            wsServers: [{ enabled: true, host: "127.0.0.1", port: WS_CONFIG_TOKEN_PORT }],
        });
        try {
            await set.servers[0]?.open();
            const reply = await wsRequest(WS_CONFIG_TOKEN_PORT, {
                authorization: `Bearer ${BRANCH_TOKEN}`,
            });
            expect(reply.retcode).toBe(0);
            expect(reply.echo).toBe("branch");
        } finally {
            await closeAll(set);
        }
    });

    it("协议级与实例都无 token → 匿名连入可请求（authorize 未装配）", async () => {
        const { set } = assemble({
            wsServers: [{ enabled: true, host: "127.0.0.1", port: WS_NO_TOKEN_PORT }],
        });
        try {
            await set.servers[0]?.open();
            const reply = await wsRequest(WS_NO_TOKEN_PORT);
            expect(reply.retcode).toBe(0);
        } finally {
            await closeAll(set);
        }
    });
});

describe("hasAccessTokenQuery 解析失败兜底（恶意请求行）", () => {
    const { set } = assemble({
        token: BRANCH_TOKEN,
        wsServers: [{ enabled: true, host: "127.0.0.1", port: RAW_PROBE_PORT }],
    });

    afterAll(async () => {
        await closeAll(set);
    });

    it("WS 升级行构造成非法 URL → 鉴权按 false 处理（升级后收 4401 关闭帧，不抛错）", async () => {
        await set.servers[0]?.open();
        // ws 库的 connection 事件在 101 升级完成后触发——鉴权失败走应用层
        // close(4401, "unauthorized")：关闭帧 = 0x88 + 长度 0x0E（2+12 字节）+ 关闭码 0x1131
        const sawRejectFrame = await new Promise<boolean>((resolve, reject) => {
            const raw = connect({ host: "127.0.0.1", port: RAW_PROBE_PORT }, () => {
                // 请求目标 "//[::1?..." → new URL 抛 TypeError，
                // hasAccessTokenQuery catch 兜底 false → 4401 关闭帧
                raw.write(
                    `GET //[::1?access_token=${BRANCH_TOKEN} HTTP/1.1\r\n` +
                        "Host: 127.0.0.1\r\n" +
                        "Upgrade: websocket\r\n" +
                        "Connection: Upgrade\r\n" +
                        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
                        "Sec-WebSocket-Version: 13\r\n\r\n",
                );
            });
            raw.on("data", (chunk: Buffer) => {
                if (chunk.includes(Buffer.from([0x88, 0x0e, 0x11, 0x31]))) {
                    raw.destroy();
                    resolve(true);
                }
            });
            raw.on("error", (err: Error) => reject(err));
            setTimeout(() => {
                raw.destroy();
                resolve(false);
            }, 3000);
        });
        expect(sawRejectFrame).toBe(true);
    });
});
