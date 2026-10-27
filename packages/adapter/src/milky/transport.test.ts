/**
 * Milky 传输集成测试（真端口：规范信封 + 404/415/401 + SSE/WS 事件推送）
 *
 * 锁定 docs/protocols/milky.md §4 的传输语义：
 *  - POST /api/:api 成功信封 {status:"ok",retcode:0,data}
 *  - 未知 API → HTTP 404 空 body；Content-Type 不符 → 415
 *  - token 鉴权：Bearer 头 / access_token 查询参数，失败 401
 *  - /event SSE：event: milky_event 帧 + data JSON；broadcaster.emit 即推送
 *  - /event WS：同端口升级，事件单条 JSON 推送
 */

import { EventBroadcaster } from "@napuketto/network";
import { afterAll, describe, expect, it } from "vitest";
import { WebSocket as WsClient } from "ws";
import { createMilkyActionRegistry } from "./action/index.js";
import { MilkyApi } from "./api.js";
import { milkyConfigSchema } from "./config.js";
import { MessageSeqIndex } from "./helper/seq-index.js";
import { assembleMilkyTransports, MilkyEventHub } from "./transport.js";

const PORT = 36221;
const TOKEN = "test-token";

/** 桩 MilkyApi（仅版本面被 get_impl_info 消费）。 */
function stubApi(): MilkyApi {
    return new MilkyApi(
        {
            msgApi: {},
            groupApi: {},
            friendApi: {},
            profileApi: {},
            self: { uin: "10000", nickname: "机器人" },
            qqVersion: "9.9.9-test",
            implVersion: "0.0.0-test",
        } as unknown as ConstructorParameters<typeof MilkyApi>[0],
        new MessageSeqIndex(),
    );
}

const broadcaster = new EventBroadcaster();
const hub = new MilkyEventHub();
const set = assembleMilkyTransports({
    config: milkyConfigSchema.parse({
        enabled: true,
        host: "127.0.0.1",
        port: PORT,
        token: TOKEN,
    }),
    broadcaster,
    registry: createMilkyActionRegistry({ api: stubApi() }),
    hub,
});

afterAll(async () => {
    await set.close();
});

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
