/**
 * satori/transport.test.ts：传输装配集成测试（真端口，127.0.0.1 固定高位端口）。
 *
 * 锁定 docs/protocols/satori.md §2 的传输语义：
 *  - HTTP RPC：POST /v1/{resource}.{method} 分发（200/404/405/400/501）；
 *    非 /v1/ 与单段路径 404；/v1/meta 不可达（文档已知限制，锁现状 404）
 *  - 鉴权：配 token 后 HTTP 要求 Bearer 头（缺失/错误 → 401）
 *  - WS 事件服务：IDENTIFY → READY（token 校验；不符/超时 → 4004 关闭）；
 *    PING → PONG；EVENT 经 broadcaster.emit **只推给已认证连接**
 *  - close：关闭传输并从 broadcaster 注销（幂等）
 */
import { kernelError } from "@napuketto/kernel";
import { EventBroadcaster } from "@napuketto/network";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket as WsClient } from "ws";
import { z } from "zod";
import { ActionRegistry } from "../../src/framework/index.js";
import type { SatoriActionHandler } from "../../src/satori/action/base-action.js";
import { createSatoriActionRegistry } from "../../src/satori/action/index.js";
import { satoriConfigSchema, toLogin } from "../../src/satori/helper/index.js";
import {
    assembleSatoriTransports,
    type SatoriTransportSet,
    toEventSignal,
} from "../../src/satori/transport.js";
import { Opcode } from "../../src/satori/types/index.js";
import { stub } from "../internal/stub.js";
import { type StubSatoriApi, stubSatoriApi } from "./action/test-support.js";

const SELF = { uin: "10001", nickname: "机器人" };
/** HTTP / WS 端口（A 组无鉴权 / B 组带 token）。 */
const PORT_HTTP_A = 36241;
const PORT_WS_A = 36242;
const PORT_HTTP_B = 36243;
const PORT_WS_B = 36244;
const TOKEN = "satori-test-token";

/** 构造带桩 api 的传输组（可选全局 token / 实例级 token / 自定义注册表；含 disabled 实例覆盖 continue 分支）。 */
function buildSet(opts: {
    httpPort: number;
    wsPort: number;
    token?: string;
    instanceToken?: string;
    registry?: ReturnType<typeof createSatoriActionRegistry>;
    identifyTimeoutMs?: number;
}): { set: SatoriTransportSet; broadcaster: EventBroadcaster; api: StubSatoriApi } {
    const api = stubSatoriApi();
    const broadcaster = new EventBroadcaster();
    const registry = opts.registry ?? createSatoriActionRegistry({ api: api as never });
    const set = assembleSatoriTransports({
        config: satoriConfigSchema.parse({
            ...(opts.token !== undefined ? { token: opts.token } : {}),
            httpServers: [
                {
                    enabled: true,
                    host: "127.0.0.1",
                    port: opts.httpPort,
                    ...(opts.instanceToken !== undefined ? { token: opts.instanceToken } : {}),
                },
                { enabled: false, host: "127.0.0.1", port: opts.httpPort },
            ],
            wsServers: [
                { enabled: true, host: "127.0.0.1", port: opts.wsPort },
                { enabled: false, host: "127.0.0.1", port: opts.wsPort },
            ],
        }),
        broadcaster,
        registry,
        login: () => toLogin(SELF, 0, true),
        ...(opts.identifyTimeoutMs !== undefined
            ? { identifyTimeoutMs: opts.identifyTimeoutMs }
            : {}),
    });
    return { set, broadcaster, api };
}

const setA = buildSet({ httpPort: PORT_HTTP_A, wsPort: PORT_WS_A });
const setB = buildSet({ httpPort: PORT_HTTP_B, wsPort: PORT_WS_B, token: TOKEN });

/** POST JSON 到 HTTP RPC（可带 Authorization）。 */
async function postRpc(
    port: number,
    path: string,
    body: unknown = {},
    headers: Record<string, string> = {},
): Promise<{ status: number; json: unknown }> {
    const res = await fetch(`http://127.0.0.1:${port}/v1/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text === "" ? null : (JSON.parse(text) as unknown) };
}

/** 等待 WS 一条消息（超时抛错）。 */
function waitMessage(ws: WsClient, timeoutMs = 3000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("等待 WS 消息超时")), timeoutMs);
        ws.once("message", (data: unknown) => {
            clearTimeout(timer);
            resolve(JSON.parse(String(data)) as Record<string, unknown>);
        });
    });
}

/** 等待一段静默期：期间收到任何消息返回 false，否则 true。 */
function expectSilence(ws: WsClient, ms = 300): Promise<boolean> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(true), ms);
        ws.once("message", () => {
            clearTimeout(timer);
            resolve(false);
        });
    });
}

/** 打开 WS 客户端（等待 open）。 */
function openWs(port: number): Promise<WsClient> {
    return new Promise((resolve, reject) => {
        const ws = new WsClient(`ws://127.0.0.1:${port}/v1/events`);
        ws.once("open", () => resolve(ws));
        ws.once("error", reject);
    });
}

/** 等待连接关闭（返回 close code 与 reason）。 */
function waitClose(ws: WsClient, timeoutMs = 3000): Promise<{ code: number; reason: string }> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("等待 WS 关闭超时")), timeoutMs);
        ws.once("close", (code, reason) => {
            clearTimeout(timer);
            resolve({ code, reason: reason.toString() });
        });
        ws.once("error", (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

beforeAll(async () => {
    await Promise.all(setA.set.adapters.map((a) => a.open()));
    await Promise.all(setB.set.adapters.map((a) => a.open()));
});

afterAll(async () => {
    await setA.set.close();
    await setB.set.close();
    vi.restoreAllMocks();
});

describe("HTTP RPC 分发", () => {
    it("POST /v1/login.get：200 + Login 资源（无 token 时免鉴权）", async () => {
        const { status, json } = await postRpc(PORT_HTTP_A, "login.get");
        expect(status).toBe(200);
        expect(json).toMatchObject({ sn: 0, platform: "qq", status: 1 });
    });

    it("非 POST 方法（DELETE 带 body）→ 405", async () => {
        const res = await fetch(`http://127.0.0.1:${PORT_HTTP_A}/v1/login.get`, {
            method: "DELETE",
            headers: { "content-type": "application/json" },
            body: "{}",
        });
        expect(res.status).toBe(405);
        await expect(res.json()).resolves.toEqual({ error: "method not allowed" });
    });

    it("未注册动作（resource.method 格式合法）→ 404", async () => {
        const { status, json } = await postRpc(PORT_HTTP_A, "message.rename");
        expect(status).toBe(404);
        expect(json).toEqual({ error: "api not found" });
    });

    it("单段路径（无点号）→ 404（不匹配 resource.method 模式）", async () => {
        const { status } = await postRpc(PORT_HTTP_A, "meta");
        // meta 分支不可达：parseActionPath 要求至少两段（文档已知限制，锁现状）
        expect(status).toBe(404);
    });

    it("非 /v1/ 前缀路径 → 404", async () => {
        const res = await fetch(`http://127.0.0.1:${PORT_HTTP_A}/other/login.get`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
        });
        expect(res.status).toBe(404);
    });

    it("参数校验失败 → 400（message.create 缺 content）", async () => {
        const { status, json } = await postRpc(PORT_HTTP_A, "message.create", {
            channel_id: "10001",
        });
        expect(status).toBe(400);
        expect(json).toEqual({ error: "参数校验失败" });
    });

    it("501 动作（channel.create）→ 501 + 平台不支持文案", async () => {
        const { status, json } = await postRpc(PORT_HTTP_A, "channel.create");
        expect(status).toBe(501);
        expect(json).toEqual({ error: "平台不支持该操作: channel.create" });
    });

    it("KernelError → 映射状态码（message.delete 撤回被拒 403）", async () => {
        vi.mocked(setA.api.msgApi.recallMessage).mockRejectedValueOnce(
            kernelError("无权限撤回", "PERMISSION_DENIED"),
        );
        const { status, json } = await postRpc(PORT_HTTP_A, "message.delete", {
            channel_id: "10001",
            message_id: "m1",
        });
        expect(status).toBe(403);
        expect(json).toEqual({ error: "无权限撤回" });
    });

    it("kernelError NOT_FOUND → 404（message.get 消息不存在）", async () => {
        const { status, json } = await postRpc(PORT_HTTP_A, "message.get", {
            channel_id: "10001",
            message_id: "gone",
        });
        expect(status).toBe(404);
        expect(json).toEqual({ error: "消息不存在" });
    });

    it("成功动作返回数据：guild.get → Guild 资源", async () => {
        const { status, json } = await postRpc(PORT_HTTP_A, "guild.get", { guild_id: "10001" });
        expect(status).toBe(200);
        expect(json).toEqual({ id: "10001", name: "测试群" });
    });
});

describe("HTTP 鉴权（token 配置组 B）", () => {
    it("无 Authorization 头 → 401", async () => {
        const res = await fetch(`http://127.0.0.1:${PORT_HTTP_B}/v1/login.get`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
        });
        expect(res.status).toBe(401);
    });

    it("Bearer token 错误 → 401", async () => {
        const res = await fetch(`http://127.0.0.1:${PORT_HTTP_B}/v1/login.get`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: "Bearer wrong" },
            body: "{}",
        });
        expect(res.status).toBe(401);
    });

    it("非 Bearer 前缀 → 401", async () => {
        const res = await fetch(`http://127.0.0.1:${PORT_HTTP_B}/v1/login.get`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: "Basic abc" },
            body: "{}",
        });
        expect(res.status).toBe(401);
    });

    it("正确 Bearer token → 200", async () => {
        const { status } = await postRpc(
            PORT_HTTP_B,
            "login.get",
            {},
            {
                authorization: `Bearer ${TOKEN}`,
            },
        );
        expect(status).toBe(200);
    });

    it("实例级 token 优先于全局（此处实例未配 → 继承全局）", async () => {
        // 组 B 全局 token 生效即继承路径的行为证明
        const { status } = await postRpc(
            PORT_HTTP_B,
            "login.get",
            {},
            {
                authorization: `Bearer ${TOKEN}`,
            },
        );
        expect(status).toBe(200);
    });
});

describe("WS 事件服务（无 token 组 A）", () => {
    it("IDENTIFY → READY（logins + proxy_urls）", async () => {
        const ws = await openWs(PORT_WS_A);
        ws.send(JSON.stringify({ op: Opcode.IDENTIFY, body: {} }));
        const msg = await waitMessage(ws);
        expect(msg["op"]).toBe(Opcode.READY);
        const body = msg["body"] as {
            logins: Record<string, unknown>[];
            proxy_urls: unknown[];
        };
        expect(body.logins).toHaveLength(1);
        expect(body.logins[0]).toMatchObject({ platform: "qq", status: 1 });
        expect(body.proxy_urls).toEqual([]);
        ws.close();
    });

    it("IDENTIFY body.sn 被忽略（不做会话恢复，直接 READY）", async () => {
        const ws = await openWs(PORT_WS_A);
        ws.send(JSON.stringify({ op: Opcode.IDENTIFY, body: { sn: 42 } }));
        const msg = await waitMessage(ws);
        expect(msg["op"]).toBe(Opcode.READY);
        ws.close();
    });

    it("PING → PONG（body null）", async () => {
        const ws = await openWs(PORT_WS_A);
        ws.send(JSON.stringify({ op: Opcode.PING }));
        const msg = await waitMessage(ws);
        expect(msg).toEqual({ op: Opcode.PONG, body: null });
        ws.close();
    });

    it("未知 op：不响应（静默期无消息）", async () => {
        const ws = await openWs(PORT_WS_A);
        ws.send(JSON.stringify({ op: 99 }));
        await expect(expectSilence(ws)).resolves.toBe(true);
        ws.close();
    });

    it("null 信令：按空对象处理（IDENTIFY 无 body 也放行）", async () => {
        const ws = await openWs(PORT_WS_A);
        ws.send(JSON.stringify({ op: Opcode.IDENTIFY }));
        const msg = await waitMessage(ws);
        expect(msg["op"]).toBe(Opcode.READY);
        ws.close();
    });

    it("broadcaster.emit(EVENT 信令) → 客户端收到完整 Event", async () => {
        const ws = await openWs(PORT_WS_A);
        // token 为空：连接即已认证；IDENTIFY 只为取 READY（协议要求）
        ws.send(JSON.stringify({ op: Opcode.IDENTIFY }));
        await waitMessage(ws);
        const signal = toEventSignal({
            sn: 1,
            type: "message-created",
            timestamp: 1700000000,
            login: {
                sn: 1,
                platform: "qq",
                user: { id: "10001" },
                status: 1,
                adapter: "napuketto",
            },
        });
        setA.broadcaster.emit(signal);
        const msg = await waitMessage(ws);
        expect(msg["op"]).toBe(Opcode.EVENT);
        expect((msg["body"] as Record<string, unknown>)["type"]).toBe("message-created");
        ws.close();
    });

    it("token 为空：未 IDENTIFY 的连接同样收到事件（空 token = 不鉴权）", async () => {
        const ws = await openWs(PORT_WS_A);
        setA.broadcaster.emit(
            toEventSignal({
                sn: 3,
                type: "login-updated",
                timestamp: 1700000002,
                login: toLogin(SELF, 3, true),
            }),
        );
        const msg = await waitMessage(ws);
        expect(msg["op"]).toBe(Opcode.EVENT);
        ws.close();
    });

    it("HTTP 实例也注册到 broadcaster：send no-op 不影响 emit 广播", async () => {
        // emit 一个事件不应抛错（HTTP send no-op；WS 客户端已关，无接收者）
        expect(() =>
            setA.broadcaster.emit(
                toEventSignal({
                    sn: 2,
                    type: "login-updated",
                    timestamp: 1700000001,
                    login: toLogin(SELF, 2, false),
                }),
            ),
        ).not.toThrow();
    });
});

describe("WS 鉴权（token 组 B）", () => {
    it.each([null, 42, true, {}, [TOKEN]])(
        "IDENTIFY 非字符串 token %j：以 4004 关闭",
        async (token) => {
            const ws = await openWs(PORT_WS_B);
            const closed = waitClose(ws);
            ws.send(JSON.stringify({ op: Opcode.IDENTIFY, body: { token } }));
            await expect(closed).resolves.toEqual({ code: 4004, reason: "unauthorized" });
        },
    );

    it("未 IDENTIFY 的连接收不到任何事件（认证前不广播）", async () => {
        const ws = await openWs(PORT_WS_B);
        setB.broadcaster.emit(
            toEventSignal({
                sn: 1,
                type: "message-created",
                timestamp: 1700000000,
                login: toLogin(SELF, 1, true),
            }),
        );
        await expect(expectSilence(ws)).resolves.toBe(true);
        ws.close();
    });

    it("IDENTIFY 缺 token：以 4004 关闭（不再挂起等待客户端超时）", async () => {
        const ws = await openWs(PORT_WS_B);
        const closed = waitClose(ws);
        ws.send(JSON.stringify({ op: Opcode.IDENTIFY, body: {} }));
        await expect(closed).resolves.toEqual({ code: 4004, reason: "unauthorized" });
    });

    it("IDENTIFY token 错误：以 4004 关闭", async () => {
        const ws = await openWs(PORT_WS_B);
        const closed = waitClose(ws);
        ws.send(JSON.stringify({ op: Opcode.IDENTIFY, body: { token: "wrong" } }));
        await expect(closed).resolves.toEqual({ code: 4004, reason: "unauthorized" });
    });

    it("IDENTIFY token 正确：READY 且随后能收到事件", async () => {
        const ws = await openWs(PORT_WS_B);
        ws.send(JSON.stringify({ op: Opcode.IDENTIFY, body: { token: TOKEN } }));
        const ready = await waitMessage(ws);
        expect(ready["op"]).toBe(Opcode.READY);
        setB.broadcaster.emit(
            toEventSignal({
                sn: 2,
                type: "login-updated",
                timestamp: 1700000001,
                login: toLogin(SELF, 2, true),
            }),
        );
        const event = await waitMessage(ws);
        expect(event["op"]).toBe(Opcode.EVENT);
        ws.close();
    });

    it("只在认证集合中检查缓冲，慢连接断开且健康连接收到事件", async () => {
        const slow = await openWs(PORT_WS_B);
        const healthy = await openWs(PORT_WS_B);
        const pending = await openWs(PORT_WS_B);
        try {
            for (const ws of [slow, healthy]) {
                const ready = waitMessage(ws);
                ws.send(JSON.stringify({ op: Opcode.IDENTIFY, body: { token: TOKEN } }));
                await expect(ready).resolves.toMatchObject({ op: Opcode.READY });
            }
            const event = toEventSignal({
                sn: 3,
                type: "login-updated",
                timestamp: 1700000002,
                login: toLogin(SELF, 3, true),
            });
            const buffered = vi
                .spyOn(WsClient.prototype, "bufferedAmount", "get")
                .mockReturnValueOnce(Number.MAX_SAFE_INTEGER);
            try {
                setB.broadcaster.emit(event);
                expect(buffered).toHaveBeenCalledTimes(2);
            } finally {
                buffered.mockRestore();
            }
            await Promise.all([
                expect(waitClose(slow)).resolves.toMatchObject({ code: 1006 }),
                expect(waitMessage(healthy)).resolves.toEqual(event),
                expect(expectSilence(pending, 30)).resolves.toBe(true),
            ]);
        } finally {
            slow.terminate();
            healthy.terminate();
            pending.terminate();
        }
    });
});

describe("Satori IDENTIFY Unicode token 精确匹配", () => {
    // JSON / WS 可以无损传递孤立代理项；不能用会将其替换的 UTF-8 比较。
    const token = "虚构令牌🔑\ud800";
    const group = buildSet({ httpPort: 36255, wsPort: 36256, token });
    beforeAll(async () => {
        await Promise.all(group.set.adapters.map((adapter) => adapter.open()));
    });
    afterAll(async () => {
        await group.set.close();
    });

    it("相同码元通过，收到 READY 与认证后事件", async () => {
        const ws = await openWs(36256);
        try {
            const ready = waitMessage(ws);
            ws.send(JSON.stringify({ op: Opcode.IDENTIFY, body: { token } }));
            expect((await ready)["op"]).toBe(Opcode.READY);
            const event = waitMessage(ws);
            group.broadcaster.emit(
                toEventSignal({
                    sn: 7,
                    type: "login-updated",
                    timestamp: 1700000000,
                    login: toLogin(SELF, 7, true),
                }),
            );
            expect((await event)["op"]).toBe(Opcode.EVENT);
        } finally {
            ws.close();
        }
    });

    it.each(["x", `${token}x`, "虚构令牌🔑\ud801", "虚构令牌🔑\ufffd"])(
        "不同长度或码元 %j 拒绝且关闭码不变",
        async (candidate) => {
            const ws = await openWs(36256);
            const closed = waitClose(ws);
            ws.send(JSON.stringify({ op: Opcode.IDENTIFY, body: { token: candidate } }));
            await expect(closed).resolves.toEqual({ code: 4004, reason: "unauthorized" });
        },
    );
});

describe("IDENTIFY 超时（组 E：短超时）", () => {
    beforeAll(async () => {
        await Promise.all(setE.set.adapters.map((a) => a.open()));
    });

    afterAll(async () => {
        await setE.set.close();
    });

    it("连接后未在超时内 IDENTIFY → 4004 关闭", async () => {
        const ws = await openWs(36250);
        const closed = await waitClose(ws);
        expect(closed.code).toBe(4004);
        expect(closed.reason).toBe("IDENTIFY timeout");
    });

    it("超时前完成 IDENTIFY → 连接保留并回 READY", async () => {
        const ws = await openWs(36250);
        ws.send(JSON.stringify({ op: Opcode.IDENTIFY, body: { token: TOKEN } }));
        const msg = await waitMessage(ws);
        expect(msg["op"]).toBe(Opcode.READY);
        ws.close();
    });
});

describe("toEventSignal 与 close", () => {
    it("toEventSignal：op=EVENT，body 原样", () => {
        const event = { sn: 1, type: "x", timestamp: 0, login: toLogin(SELF, 1, true) };
        expect(toEventSignal(event)).toEqual({ op: Opcode.EVENT, body: event });
    });
});

/** 组 C：实例级 token 覆盖全局 + disabled 服务器（覆盖 continue / ?? 分支）。 */
const setC = buildSet({
    httpPort: 36245,
    wsPort: 36246,
    token: TOKEN,
    instanceToken: "inst",
});

/** 组 D：自定义注册表（抛普通 Error 的动作 → 500 兜底路径）。 */
const setD = buildSet({
    httpPort: 36247,
    wsPort: 36248,
    registry: (() => {
        const reg = new ActionRegistry<SatoriActionHandler>();
        reg.register(
            stub<SatoriActionHandler>({
                name: "boom.action",
                schema: z.object({}).passthrough(),
                run: async () => {
                    throw new Error("原始错误");
                },
            }),
        );
        reg.register(
            stub<SatoriActionHandler>({
                name: "boom2.action",
                schema: z.object({}).passthrough(),
                run: async () => {
                    throw 42; // 非 Error 抛出物：internal error 兜底
                },
            }),
        );
        return reg;
    })(),
});

/** 组 E：短 IDENTIFY 超时（未鉴权连接的回收用例，避免测试等满 10s）。 */
const setE = buildSet({
    httpPort: 36249,
    wsPort: 36250,
    token: TOKEN,
    identifyTimeoutMs: 1000,
});

describe("实例级 token 与 disabled 服务器（组 C）", () => {
    beforeAll(async () => {
        await Promise.all(setC.set.adapters.map((a) => a.open()));
    });

    afterAll(async () => {
        await setC.set.close();
    });

    it("enabled=false 的实例：跳过装配（disabled 分支，open 不报错）", async () => {
        // 组 C 配置含 disabled 实例：adapters 只含 enabled 项（HTTP+WS 各一）
        expect(setC.set.adapters).toHaveLength(2);
    });

    it("实例级 token 覆盖全局：错误实例 token → 401", async () => {
        const res = await fetch("http://127.0.0.1:36245/v1/login.get", {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
            body: "{}",
        });
        expect(res.status).toBe(401);
    });

    it("实例级 token 正确 → 200", async () => {
        const res = await fetch("http://127.0.0.1:36245/v1/login.get", {
            method: "POST",
            headers: { "content-type": "application/json", authorization: "Bearer inst" },
            body: "{}",
        });
        expect(res.status).toBe(200);
    });
});

describe("响应兜底（组 D 自定义注册表 + 组 A 补充）", () => {
    beforeAll(async () => {
        await Promise.all(setD.set.adapters.map((a) => a.open()));
    });

    afterAll(async () => {
        await setD.set.close();
    });

    it("动作抛普通 Error（非 SatoriActionError）→ 500 internal 兜底", async () => {
        const res = await fetch("http://127.0.0.1:36247/v1/boom.action", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
        });
        expect(res.status).toBe(500);
        await expect(res.json()).resolves.toEqual({ error: "原始错误" });
    });

    it("动作抛非 Error 抛出物 → 500 internal error 兜底", async () => {
        const res = await fetch("http://127.0.0.1:36247/v1/boom2.action", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
        });
        expect(res.status).toBe(500);
        await expect(res.json()).resolves.toEqual({ error: "internal error" });
    });

    it("void 动作成功 → 200 空 body 语义（data ?? {} 分支）", async () => {
        const { status, json } = await postRpc(PORT_HTTP_A, "message.delete", {
            channel_id: "10001",
            message_id: "m1",
        });
        expect(status).toBe(200);
        expect(json).toEqual({});
    });
});

describe("WS 信令兜底", () => {
    it("null 信令：按空对象处理，无 op → 忽略（?? 分支）", async () => {
        const ws = await openWs(PORT_WS_A);
        ws.send("null");
        await expect(expectSilence(ws)).resolves.toBe(true);
        ws.close();
    });

    it("close 幂等：二次 close 不抛错（此前 afterAll 已统一关闭）", async () => {
        await expect(setA.set.close()).resolves.toBeUndefined();
    });
});
