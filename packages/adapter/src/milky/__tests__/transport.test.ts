/**
 * Milky 传输集成测试（真端口：规范信封 + 404/415/401 + SSE/WS 事件推送）
 *
 * 锁定 docs/protocols/milky.md §4 的传输语义：
 *  - POST /api/:api 成功信封 {status:"ok",retcode:0,data}
 *  - 未知 API → HTTP 404 空 body；Content-Type 不符 → 415
 *  - token 鉴权：Bearer 头 / access_token 查询参数，失败 401
 *  - /event SSE：event: milky_event 帧 + data JSON；broadcaster.emit 即推送
 *  - /event WS：同端口升级，事件单条 JSON 推送
 * 另覆盖分发/事件分支（自 transport-branches 并入）：handle 抛错 -500、
 * ok data=null → {}、failed 信封、eventModes 禁用、WS 关闭帧、webhook onError。
 *
 * 关闭回归：由 set.close() 关闭仍活跃的 SSE/WS，验证流正常结束与 1001 关闭帧。
 */

import {
    type FriendApi,
    type GroupApi,
    type MsgApi,
    type MsgListener,
    NTEventChannel,
    type ProfileApi,
} from "@napuketto/kernel";
import { EventBroadcaster } from "@napuketto/network";
import { afterAll, describe, expect, it, vi } from "vitest";
import { WebSocket as WsClient } from "ws";
import { type ActionRegistry, ConfigBase } from "../../framework/index.js";
import { stub } from "../../internal/__tests__/stub.js";
import type { MilkyAction } from "../action/base-action.js";
import { createMilkyActionRegistry } from "../action/index.js";
import { NapukettoMilkyAdapter } from "../adapter.js";
import { MilkyApi } from "../api.js";
import { milkyConfigSchema } from "../config.js";
import { MessageSeqIndex } from "../helper/state/seq-index.js";
import { assembleMilkyTransports, type MilkyLoggerLike } from "../transport.js";

const PORT = 36221;
const TOKEN = "test-token";

/** 桩 MilkyApi（仅版本面被 get_impl_info 消费）。 */
function stubApi(): MilkyApi {
    return new MilkyApi(
        stub<ConstructorParameters<typeof MilkyApi>[0]>({
            msgApi: stub<MsgApi>({}),
            groupApi: stub<GroupApi>({}),
            friendApi: stub<FriendApi>({}),
            profileApi: stub<ProfileApi>({}),
            self: { uin: "10000", nickname: "机器人" },
            qqVersion: "9.9.9-test",
            implVersion: "0.0.0-test",
        }),
        new MessageSeqIndex(),
    );
}

const broadcaster = new EventBroadcaster();
const set = assembleMilkyTransports({
    config: milkyConfigSchema.parse({
        enabled: true,
        host: "127.0.0.1",
        port: PORT,
        token: TOKEN,
    }),
    broadcaster,
    registry: createMilkyActionRegistry({ api: stubApi() }),
});

afterAll(async () => {
    await set.close();
    vi.restoreAllMocks();
});

/** 动作结果双面桩（get 按名返回用例注入的行为）。 */
function fakeRegistry(
    impl: (name: string) => { handle: (payload: unknown) => Promise<unknown> },
): ActionRegistry<MilkyAction<unknown, unknown>> {
    return stub<ActionRegistry<MilkyAction<unknown, unknown>>>({
        get: (name: string) => impl(name) as MilkyAction<unknown, unknown>,
        names: [],
    });
}

/** 装配传输（端口 + 可选注册表/logger）。 */
function assemble(opts: {
    port: number;
    registry?: ActionRegistry<MilkyAction<unknown, unknown>>;
    logger?: MilkyLoggerLike;
    eventModes?: Array<"sse" | "ws">;
    token?: string;
    webhooks?: string[];
}) {
    return assembleMilkyTransports({
        config: milkyConfigSchema.parse({
            enabled: true,
            host: "127.0.0.1",
            port: opts.port,
            ...(opts.eventModes !== undefined ? { eventModes: opts.eventModes } : {}),
            ...(opts.token !== undefined ? { token: opts.token } : {}),
            ...(opts.webhooks !== undefined ? { webhooks: opts.webhooks } : {}),
        }),
        broadcaster: new EventBroadcaster(),
        ...(opts.registry !== undefined
            ? { registry: opts.registry }
            : {
                  registry: fakeRegistry(() => ({
                      handle: async () => ({ status: "ok", retcode: 0, data: { pong: 1 } }),
                  })),
              }),
        ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
    });
}

/** POST /api 快捷调用。 */
function post(
    port: number,
    api: string,
    headers: Record<string, string>,
    body: string | Uint8Array = "{}",
): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/api/${api}`, {
        method: "POST",
        headers,
        body,
    });
}

const JSON_HEADERS = { "content-type": "application/json" };

describe("Milky HTTP API", () => {
    it("POST /api/get_impl_info：200 信封 {status,retcode,data}", async () => {
        await set.adapters[0]?.open();
        const res = await fetch(`http://127.0.0.1:${PORT}/api/get_impl_info`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
            body: "{}",
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
            status: string;
            retcode: number;
            data: Record<string, unknown>;
        };
        expect(body.status).toBe("ok");
        expect(body.retcode).toBe(0);
        expect(body.data["milky_version"]).toBe("1.3");
    });

    it("鉴权：Bearer 头缺失 → 401；access_token 查询参数可兜底", async () => {
        await set.adapters[0]?.open();
        const denied = await fetch(`http://127.0.0.1:${PORT}/api/get_impl_info`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
        });
        expect(denied.status).toBe(401);
        const viaQuery = await fetch(
            `http://127.0.0.1:${PORT}/api/get_impl_info?access_token=${TOKEN}`,
            { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
        );
        expect(viaQuery.status).toBe(200);
    });

    it("未知 API → HTTP 404 空 body", async () => {
        await set.adapters[0]?.open();
        const res = await fetch(`http://127.0.0.1:${PORT}/api/no_such_api`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
            body: "{}",
        });
        expect(res.status).toBe(404);
        expect(await res.text()).toBe("");
    });

    it("Content-Type 不支持 → 415", async () => {
        await set.adapters[0]?.open();
        const res = await fetch(`http://127.0.0.1:${PORT}/api/get_impl_info`, {
            method: "POST",
            headers: { "content-type": "text/plain", authorization: `Bearer ${TOKEN}` },
            body: "{}",
        });
        expect(res.status).toBe(415);
    });

    it("参数解析失败 → 200 信封 retcode=-400", async () => {
        await set.adapters[0]?.open();
        const res = await fetch(`http://127.0.0.1:${PORT}/api/send_group_message`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
            body: JSON.stringify({ group_id: "bad" }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string; retcode: number };
        expect(body.status).toBe("failed");
        expect(body.retcode).toBe(-400);
    });
});

describe("Milky 事件推送（/event）", () => {
    it("SSE：event: milky_event 帧 + data JSON；broadcaster.emit 即推送", async () => {
        await set.adapters[0]?.open();
        const controller = new AbortController();
        const res = await fetch(`http://127.0.0.1:${PORT}/event?access_token=${TOKEN}`, {
            signal: controller.signal,
        });
        expect(res.headers.get("content-type")).toContain("text/event-stream");
        const reader = res.body?.getReader();
        // 订阅就绪后广播一条事件（hub 已在 SSE 响应构造时注册）
        broadcaster.emit({
            time: 1760000000,
            self_id: 10000,
            event_type: "message_receive",
            data: { message_scene: "group" },
        });
        const decoder = new TextDecoder();
        const { value } = (await reader?.read()) ?? { value: undefined };
        const text = decoder.decode(value ?? new Uint8Array());
        expect(text).toContain("event: milky_event\n");
        expect(text).toContain(
            'data: {"time":1760000000,"self_id":10000,"event_type":"message_receive"',
        );
        controller.abort();
    });

    it("WS：同端口 /event 升级，事件单条 JSON 推送", async () => {
        await set.adapters[0]?.open();
        const received = await new Promise<string>((resolve, reject) => {
            const ws = new WsClient(`ws://127.0.0.1:${PORT}/event?access_token=${TOKEN}`);
            ws.on("open", () => {
                broadcaster.emit({
                    time: 1760000001,
                    self_id: 10000,
                    event_type: "message_recall",
                    data: { message_scene: "group" },
                });
            });
            ws.on("message", (raw) => {
                resolve(raw.toString());
                ws.close();
            });
            ws.on("error", (err) => reject(err));
            setTimeout(() => reject(new Error("WS 事件推送超时")), 3000);
        });
        const parsed = JSON.parse(received) as { event_type: string };
        expect(parsed.event_type).toBe("message_recall");
    });
});

/**
 * 适配器级回归（实机发现）：NapukettoMilkyAdapter.start 必须自行
 * open 传输——此前 startTransports 只装配不监听，集成测试显式
 * `set.adapters[0]?.open` 掩盖了该缺口（milky HTTP 从未真正绑端口）。
 */
describe("Milky 适配器 start 即监听（回归）", () => {
    const AdapterPort = 36222;
    const adapter = new NapukettoMilkyAdapter(
        stub<ConstructorParameters<typeof NapukettoMilkyAdapter>[0]>({
            config: new ConfigBase({
                path: "milky-adapter-start-test.toml",
                schema: milkyConfigSchema,
                defaults: milkyConfigSchema.parse({}),
                seed: milkyConfigSchema.parse({
                    enabled: true,
                    host: "127.0.0.1",
                    port: AdapterPort,
                    token: "",
                }),
            }),
            broadcaster: new EventBroadcaster(),
            msgChannel: new NTEventChannel<MsgListener, "Msg">("Msg"),
            msgApi: stub<MsgApi>({}),
            groupApi: stub<GroupApi>({}),
            friendApi: stub<FriendApi>({}),
            profileApi: stub<ProfileApi>({}),
            self: { uin: "10000", nickname: "机器人" },
            qqVersion: "9.9.9-test",
        }),
    );

    it("start() 后无需显式 open，HTTP 动作即可达", async () => {
        await adapter.start();
        try {
            const res = await fetch(`http://127.0.0.1:${AdapterPort}/api/get_impl_info`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: "{}",
            });
            expect(res.status).toBe(200);
        } finally {
            await adapter.stop();
        }
    });
});

describe("HTTP /api 分发分支", () => {
    const set = assemble({ port: 36401 });

    afterAll(async () => {
        await set.close();
    });

    it("action.handle 抛错 → 200 信封 retcode=-500 internal error", async () => {
        const boom = assemble({
            port: 36402,
            registry: fakeRegistry(() => ({
                handle: async () => {
                    throw new Error("boom");
                },
            })),
        });
        try {
            await boom.adapters[0]?.open();
            const res = await post(36402, "get_login_info", JSON_HEADERS);
            expect(res.status).toBe(200);
            expect(await res.json()).toEqual({
                status: "failed",
                retcode: -500,
                data: null,
                message: "internal error",
            });
        } finally {
            await boom.close();
        }
    });

    it("ok 信封 data=null → data 兜底 {}；failed 信封 retcode/message 原样", async () => {
        const custom = assemble({
            port: 36403,
            registry: fakeRegistry((name) => ({
                handle: async () =>
                    name === "null_data"
                        ? { status: "ok", retcode: 0, data: null }
                        : { status: "failed", retcode: -404, data: null, message: "missing" },
            })),
        });
        try {
            await custom.adapters[0]?.open();
            const okRes = await post(36403, "null_data", JSON_HEADERS);
            expect(await okRes.json()).toEqual({ status: "ok", retcode: 0, data: {} });
            const failed = await post(36403, "missing_thing", JSON_HEADERS);
            expect(await failed.json()).toEqual({
                status: "failed",
                retcode: -404,
                data: null,
                message: "missing",
            });
        } finally {
            await custom.close();
        }
    });

    it("POST 非 /api 路径 → 404 空 body（非 POST 分支由 node-server bodyless 语义遮挡，属防御性）", async () => {
        await set.adapters[0]?.open();
        const wrongPath = await fetch("http://127.0.0.1:36401/other", {
            method: "POST",
            headers: JSON_HEADERS,
            body: "{}",
        });
        expect(wrongPath.status).toBe(404);
        expect(await wrongPath.text()).toBe("");
    });

    it("无 content-type 头（Buffer body）→ 放行非 415", async () => {
        await set.adapters[0]?.open();
        const res = await post(36401, "get_login_info", {}, new TextEncoder().encode("{}"));
        expect(res.status).toBe(200);
    });

    it("content-type 大小写不敏感（APPLICATION/JSON → 放行）", async () => {
        await set.adapters[0]?.open();
        const res = await post(36401, "get_login_info", {
            "content-type": "APPLICATION/JSON; charset=utf-8",
        });
        expect(res.status).toBe(200);
    });
});

describe("/event 模式开关与鉴权分支", () => {
    it("sse 禁用（eventModes=[ws]）→ GET /event 404 + 文本说明", async () => {
        const set = assemble({ port: 36404, eventModes: ["ws"] });
        try {
            await set.adapters[0]?.open();
            const res = await fetch("http://127.0.0.1:36404/event");
            expect(res.status).toBe(404);
            expect(await res.text()).toContain("sse disabled");
        } finally {
            await set.close();
        }
    });

    it("ws 禁用（eventModes=[sse]）→ 升级请求 404 拒绝", async () => {
        const set = assemble({ port: 36405, eventModes: ["sse"] });
        try {
            await set.adapters[0]?.open();
            const outcome = await wsOutcome("ws://127.0.0.1:36405/event", 2000);
            expect(outcome).toContain("404");
        } finally {
            await set.close();
        }
    });

    it("ws token 错误 → 401 拒绝（Unexpected server response: 401）", async () => {
        const set = assemble({ port: 36406, eventModes: ["ws"], token: "tok" });
        try {
            await set.adapters[0]?.open();
            const outcome = await wsOutcome("ws://127.0.0.1:36406/event?access_token=wrong", 2000);
            expect(outcome).toContain("401");
        } finally {
            await set.close();
        }
    });

    it("set.close：活跃 SSE 正常结束、WS 收到 1001，并发与重复关闭安全", async () => {
        const set = assemble({ port: 36407, eventModes: ["sse", "ws"] });
        await set.adapters[0]?.open();
        const controller = new AbortController();
        const ws = new WsClient("ws://127.0.0.1:36407/event");
        try {
            await new Promise<void>((resolve, reject) => {
                ws.once("open", () => resolve());
                ws.once("error", reject);
            });
            const res = await fetch("http://127.0.0.1:36407/event", { signal: controller.signal });
            const reader = res.body?.getReader();
            expect(reader).toBeDefined();
            const eof = reader?.read().catch(() => undefined);
            const closed = new Promise<{ code: number; reason: string }>((resolve) => {
                ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
            });
            const closing = set.close();
            let finished = false;
            // 观察完成状态；原 closing 在下方 await，保留其失败诊断。
            const completion = closing
                .finally(() => {
                    finished = true;
                })
                .catch(() => undefined);
            await vi.waitFor(() => expect(finished).toBe(true), { timeout: 1000 });
            await Promise.all([completion, closing, set.close(), set.close()]);
            expect(await eof).toEqual({ done: true, value: undefined });
            expect(await closed).toEqual({ code: 1001, reason: "server shutdown" });
        } finally {
            controller.abort();
            ws.terminate();
            // 断言失败时也回收连接，保证旧实现的失败不会卡住后续用例。
            await set.adapters[1]?.close();
            await set.close();
        }
    });

    it("WS 升级到非 /event 路径 → hub 不承接（连接不建立）", async () => {
        const set = assemble({ port: 36409, eventModes: ["ws"] });
        const client = new WsClient("ws://127.0.0.1:36409/other");
        try {
            await set.adapters[0]?.open();
            const outcome = await new Promise<string>((resolve) => {
                client.on("error", (e: Error) => resolve(String(e)));
                client.on("open", () => resolve("open"));
                setTimeout(() => resolve("timeout"), 1500);
            });
            expect(outcome).not.toBe("open");
        } finally {
            client.terminate();
            await set.close();
        }
    });

    it("webhook 无 token → 不带 authorization 头装配", async () => {
        const logger: MilkyLoggerLike = { debug: vi.fn(), warn: vi.fn(), info: vi.fn() };
        const set = assemble({
            port: 36410,
            webhooks: ["http://127.0.0.1:9/noauth"],
            logger,
        });
        try {
            expect(set.adapters.length).toBe(3);
            set.adapters[2]?.send({ ping: 1 });
            await vi.waitFor(
                () => {
                    expect(logger.warn).toHaveBeenCalledWith(
                        expect.objectContaining({ url: "http://127.0.0.1:9/noauth" }),
                        expect.any(String),
                    );
                },
                { timeout: 3000 },
            );
        } finally {
            await set.close();
        }
    });

    /** WS 连接结果短句（open / error 文本 / 超时）。 */
    function wsOutcome(url: string, timeoutMs: number): Promise<string> {
        return new Promise<string>((resolve) => {
            const ws = new WsClient(url);
            ws.on("error", (e: Error) => resolve(String(e)));
            ws.on("open", () => resolve("open"));
            setTimeout(() => resolve("timeout"), timeoutMs);
        });
    }
});

describe("WebHook 推送", () => {
    it("不可达 webhook → onError → logger.warn（不影响其他 adapter）", async () => {
        const logger: MilkyLoggerLike = { debug: vi.fn(), warn: vi.fn(), info: vi.fn() };
        const set = assemble({
            port: 36408,
            webhooks: ["http://127.0.0.1:9/hook"],
            logger,
            token: "t",
        });
        try {
            await set.adapters[0]?.open();
            // adapters[0]=server, [1]=hub, [2..]=webhook clients
            expect(set.adapters.length).toBe(3);
            set.adapters[2]?.send({ ping: 1 });
            await vi.waitFor(
                () => {
                    expect(logger.warn).toHaveBeenCalledWith(
                        expect.objectContaining({ url: "http://127.0.0.1:9/hook" }),
                        expect.stringContaining("webhook"),
                    );
                },
                { timeout: 3000 },
            );
        } finally {
            await set.close();
        }
    });
});
