/**
 * satori/transport.test.ts：传输装配集成测试（真端口，127.0.0.1 固定高位端口）。
 *
 * 锁定 docs/protocols/satori.md §2 的传输语义：
 *  - HTTP RPC：POST /v1/{resource}.{method} 分发（200/404/405/400/501）；
 *    非 /v1/ 与单段路径 404；/v1/meta 不可达（文档已知限制，锁现状 404）
 *  - 鉴权：配 token 后 HTTP 要求 Bearer 头（缺失/错误 → 401）
 *  - WS 事件服务：IDENTIFY → READY（token 校验，失败不响应）；PING → PONG；
 *    EVENT 经 broadcaster.emit 推送
 *  - close：关闭传输并从 broadcaster 注销（幂等）
 */
import { kernelError } from "@napuketto/kernel";
import { EventBroadcaster } from "@napuketto/network";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket as WsClient } from "ws";
import { z } from "zod";
import { stub } from "../../core/__tests__/stub.js";
import { ActionRegistry } from "../../core/framework/action-registry.js";
import { type StubSatoriApi, stubSatoriApi } from "../action/__tests__/test-support.js";
import type { BaseSatoriAction } from "../action/base-action.js";
import { createSatoriActionRegistry } from "../action/index.js";
import { satoriConfigSchema, toLogin } from "../helper/index.js";
import { assembleSatoriTransports, type SatoriTransportSet, toEventSignal } from "../transport.js";
import { Opcode } from "../types/index.js";

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

    it("意外异常 → 500（message.get 消息不存在兜底）", async () => {
        const { status, json } = await postRpc(PORT_HTTP_A, "message.get", {
            channel_id: "10001",
            message_id: "gone",
        });
        expect(status).toBe(500);
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
        // 先 IDENTIFY（协议要求，服务端不强制）
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
    it("IDENTIFY 无 token：不响应（客户端超时断开语义）", async () => {
        const ws = await openWs(PORT_WS_B);
        ws.send(JSON.stringify({ op: Opcode.IDENTIFY, body: {} }));
        await expect(expectSilence(ws)).resolves.toBe(true);
        ws.close();
    });

    it("IDENTIFY token 错误：不响应", async () => {
        const ws = await openWs(PORT_WS_B);
        ws.send(JSON.stringify({ op: Opcode.IDENTIFY, body: { token: "wrong" } }));
        await expect(expectSilence(ws)).resolves.toBe(true);
        ws.close();
    });

    it("IDENTIFY token 正确：READY", async () => {
        const ws = await openWs(PORT_WS_B);
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
        const reg = new ActionRegistry<BaseSatoriAction<unknown, unknown>>();
        reg.register(
            stub<BaseSatoriAction<unknown, unknown>>({
                name: "boom.action",
                schema: z.object({}).passthrough(),
                run: async () => {
                    throw new Error("原始错误");
                },
            }),
        );
        reg.register(
            stub<BaseSatoriAction<unknown, unknown>>({
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
