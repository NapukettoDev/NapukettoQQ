/**
 * satori/adapter.test.ts：NapukettoSatoriAdapter 收链路与生命周期单测。
 *
 * （传输装配/重建语义见 adapter-reload.test.ts 与 transport.test.ts，此处
 * 聚焦消息事件广播：sn 递增、事件形状、grayTip 分流、退订幂等、无 broadcaster
 * 降级、翻译失败 warn 留痕。）
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatType } from "@napuketto/kernel";
import { afterAll, describe, expect, it, vi } from "vitest";
import { WebSocket as WsClient } from "ws";
import { ConfigBase } from "../../core/index.js";
import { stub } from "../../shared/__tests__/stub.js";
import { type StubSatoriApi, stubSatoriApi } from "../action/__tests__/test-support.js";
import { NapukettoSatoriAdapter } from "../adapter.js";
import { SatoriApi } from "../api/satori-api.js";
import { satoriConfigSchema } from "../helper/index.js";
import type { Event } from "../types/index.js";
import { Opcode } from "../types/index.js";
import {
    fakeMsgChannel,
    makeMemberChangeMsg,
    makeRawMsg,
    makeRevokeMsg,
    spyBroadcaster,
} from "./test-support.js";

let tmpRoot = "";

afterAll(() => {
    if (tmpRoot !== "") {
        rmSync(tmpRoot, { recursive: true, force: true });
    }
});

/** 等待 WS 一条消息（适配器端到端用；transport.test.ts 有同构实现）。 */
function waitWsMessage(
    ws: import("ws").WebSocket,
    timeoutMs = 3000,
): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("等待 WS 消息超时")), timeoutMs);
        ws.once("message", (data: unknown) => {
            clearTimeout(timer);
            resolve(JSON.parse(String(data)) as Record<string, unknown>);
        });
    });
}

/** 打开 WS 客户端（适配器端到端用）。 */
function openWs(port: number): Promise<import("ws").WebSocket> {
    return new Promise((resolve, reject) => {
        const ws = new WsClient(`ws://127.0.0.1:${port}/v1/events`);
        ws.once("open", () => resolve(ws));
        ws.once("error", reject);
    });
}

/** 排空广播链（广播异步链路全部走微任务，一个宏任务轮次足够）。 */
async function drain(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
}

/** 构造适配器（seed 配置，不落盘；stub api + spy broadcaster + 假消息通道）。 */
function makeAdapter(
    api: StubSatoriApi,
    spy?: ReturnType<typeof spyBroadcaster>,
    logger?: {
        warn: (obj: unknown, msg?: string) => void;
        debug: (obj: unknown, msg?: string) => void;
        info: (obj: unknown, msg?: string) => void;
    },
): {
    adapter: NapukettoSatoriAdapter;
    fire: (msgs: unknown) => void;
    fireAndWait: (msgs: unknown) => Promise<void>;
    events: unknown[];
} {
    if (tmpRoot === "") {
        tmpRoot = mkdtempSync(join(tmpdir(), "nk-test-satori-adapter-"));
    }
    const { channel, fire } = fakeMsgChannel();
    const adapter = new NapukettoSatoriAdapter(
        stub<ConstructorParameters<typeof NapukettoSatoriAdapter>[0]>({
            msgApi: api.msgApi,
            groupApi: api.groupApi,
            groupNotifyApi: api.groupNotifyApi,
            friendApi: api.friendApi,
            profileApi: api.profileApi,
            self: api.self,
            cacheDir: api.cacheDir,
            config: new ConfigBase({
                path: join(tmpRoot, "cfg.toml"),
                schema: satoriConfigSchema,
                defaults: satoriConfigSchema.parse({}),
                seed: satoriConfigSchema.parse({}),
            }),
            ...(spy !== undefined ? { broadcaster: spy.broadcaster } : {}),
            ...(logger !== undefined ? { logger } : {}),
            msgChannel: channel,
        }),
    );
    return {
        adapter,
        fire,
        fireAndWait: async (msgs: unknown) => {
            fire(msgs);
            await drain();
        },
        events: spy !== undefined ? spy.events : [],
    };
}

/** 提取事件 body（信令 → Event）。 */
function eventBodies(events: unknown[]): Event[] {
    return events
        .map((e) => (e as { body?: Event }).body)
        .filter((b): b is Event => b !== undefined);
}

describe("start / stop 生命周期", () => {
    it("start：订阅消息通道 + 广播 login-updated（在线，sn=1）", async () => {
        const spyResult = spyBroadcaster();
        const { adapter } = makeAdapter(stubSatoriApi(), spyResult);
        await adapter.start();
        const bodies = eventBodies(spyResult.events);
        expect(bodies).toHaveLength(1);
        expect(bodies[0]).toMatchObject({ type: "login-updated", sn: 1 });
        expect(bodies[0]?.login).toMatchObject({ status: 1, platform: "qq" });
        expect(bodies[0]?.timestamp).toEqual(expect.any(Number));
    });

    it("stop：退订 + 广播 login-updated（离线）；stop 后消息不再广播", async () => {
        const spyResult = spyBroadcaster();
        const { adapter, fireAndWait } = makeAdapter(stubSatoriApi(), spyResult);
        await adapter.start();
        await adapter.stop();
        const bodies = eventBodies(spyResult.events);
        expect(bodies).toHaveLength(2);
        expect(bodies[1]).toMatchObject({ type: "login-updated", sn: 2 });
        expect(bodies[1]?.login).toMatchObject({ status: 0 });
        // 退订后不再消费
        await fireAndWait(makeRawMsg());
        expect(eventBodies(spyResult.events)).toHaveLength(2);
    });

    it("未 start 直接 stop：无事件（生命周期守卫）", async () => {
        const spyResult = spyBroadcaster();
        const { adapter } = makeAdapter(stubSatoriApi(), spyResult);
        await adapter.stop();
        expect(spyResult.events).toHaveLength(0);
    });

    it("无 broadcaster：start/stop 不抛错，仍订阅（仅无事件输出）", async () => {
        const { adapter, fire } = makeAdapter(stubSatoriApi());
        await expect(adapter.start()).resolves.toBeUndefined();
        await expect(adapter.stop()).resolves.toBeUndefined();
        expect(() => fire(makeRawMsg())).not.toThrow();
    });

    it("reload：离线 + 在线两次广播，重订阅后仍收消息", async () => {
        const spyResult = spyBroadcaster();
        const { adapter, fireAndWait } = makeAdapter(stubSatoriApi(), spyResult);
        await adapter.start();
        await adapter.reload();
        const bodies = eventBodies(spyResult.events);
        expect(bodies.map((e) => `${e.type}:${e.login.status}`)).toEqual([
            "login-updated:1",
            "login-updated:0",
            "login-updated:1",
        ]);
        await fireAndWait(makeRawMsg());
        const types = eventBodies(spyResult.events).map((e) => e.type);
        expect(types[types.length - 1]).toBe("message-created");
    });
});

describe("收链路广播（Msg/onRecvMsg）", () => {
    it("普通消息 → message-created（sn 递增 + 最小 login + 资源提升）", async () => {
        const spyResult = spyBroadcaster();
        const { adapter, fireAndWait } = makeAdapter(stubSatoriApi(), spyResult);
        await adapter.start();
        await fireAndWait([makeRawMsg()]);
        const bodies = eventBodies(spyResult.events);
        expect(bodies).toHaveLength(2);
        const created = bodies[1];
        expect(created?.type).toBe("message-created");
        expect(created?.sn).toBe(2);
        expect(created?.message?.id).toBe("m1");
        expect(created?.guild).toEqual({ id: "10001", name: "测试群" });
        expect(created?.channel).toEqual({ id: "10001", type: 0, name: "测试群" });
        expect(created?.user).toEqual({ id: "90001", name: "小明" });
        // login.sn 是登录序号，与事件 sn（此处为 2）是两套计数：非登录事件固定 0
        expect(created?.login).toMatchObject({ platform: "qq", sn: 0 });
        // 收方向回填频道类型缓存（adapter 内部 SatoriApi 实例；原型 spy 观察）
        const spy = vi.spyOn(SatoriApi.prototype, "setChannelType");
        await fireAndWait([makeRawMsg({ msgId: "again" })]);
        expect(spy).toHaveBeenCalledWith("10001", true);
        spy.mockRestore();
    });

    it("单条对象（非数组）入参同样广播", async () => {
        const spyResult = spyBroadcaster();
        const { adapter, fireAndWait } = makeAdapter(stubSatoriApi(), spyResult);
        await adapter.start();
        await fireAndWait(makeRawMsg({ msgId: "solo" }));
        const bodies = eventBodies(spyResult.events);
        expect(bodies[bodies.length - 1]?.message?.id).toBe("solo");
    });

    it("无效项过滤：null / 非对象不广播，合法项继续", async () => {
        const spyResult = spyBroadcaster();
        const { adapter, fireAndWait } = makeAdapter(stubSatoriApi(), spyResult);
        await adapter.start();
        await fireAndWait([null, 42, makeRawMsg({ msgId: "ok" })]);
        const bodies = eventBodies(spyResult.events);
        expect(bodies).toHaveLength(2); // login-updated + message-created
        expect(bodies[1]?.message?.id).toBe("ok");
    });

    it("sn 跨事件递增（login-updated → message → grayTip ×2）", async () => {
        const spyResult = spyBroadcaster();
        const { adapter, fireAndWait } = makeAdapter(stubSatoriApi(), spyResult);
        await adapter.start();
        await fireAndWait([makeRawMsg({ msgId: "a" })]);
        await fireAndWait([makeRevokeMsg({ msgId: "b" })]);
        await fireAndWait([makeMemberChangeMsg({ groupElement: { type: 1, memberUid: "m-uid" } })]);
        const sns = eventBodies(spyResult.events).map((e) => e.sn);
        expect(sns).toEqual([1, 2, 3, 4]);
    });

    it("事件信令 op = EVENT（协议帧形状）", async () => {
        const spyResult = spyBroadcaster();
        const { adapter, fireAndWait } = makeAdapter(stubSatoriApi(), spyResult);
        await adapter.start();
        await fireAndWait([makeRawMsg()]);
        expect((spyResult.events[0] as { op: number }).op).toBe(Opcode.EVENT);
    });
});

describe("grayTip 分流", () => {
    it("撤回 grayTip → message-deleted（operator uid 原样：stub uidToUin 恒等）", async () => {
        const spyResult = spyBroadcaster();
        const { adapter, fireAndWait } = makeAdapter(stubSatoriApi(), spyResult);
        await adapter.start();
        await fireAndWait([makeRevokeMsg({ msgSeq: "9" })]);
        const bodies = eventBodies(spyResult.events);
        const last = bodies[bodies.length - 1];
        expect(last?.type).toBe("message-deleted");
        expect(last?.message?.id).toBe("9");
        expect(last?.operator).toEqual({ id: "op-uid-1" });
    });

    it("群成员变动 grayTip → guild-member-added（guild/channel/member/user/operator）", async () => {
        const spyResult = spyBroadcaster();
        const { adapter, fireAndWait } = makeAdapter(stubSatoriApi(), spyResult);
        await adapter.start();
        await fireAndWait([
            makeMemberChangeMsg({
                groupElement: {
                    type: 1,
                    memberUid: "member-uid",
                    memberNick: "新人",
                    adminUid: "admin-uid",
                    adminNick: "管理员",
                },
            }),
        ]);
        const bodies = eventBodies(spyResult.events);
        const last = bodies[bodies.length - 1];
        expect(last?.type).toBe("guild-member-added");
        expect(last?.guild).toEqual({ id: "10001", name: "测试群" });
        expect(last?.channel).toEqual({ id: "10001", type: 0 });
        expect(last?.member).toEqual({ user: { id: "member-uid", name: "新人" } });
        expect(last?.user).toEqual({ id: "member-uid", name: "新人" });
        expect(last?.operator).toEqual({ id: "admin-uid", name: "管理员" });
    });

    it("不可翻译 grayTip（JSON 子类型）→ hasSatoriGrayTip false → message-created", async () => {
        const spyResult = spyBroadcaster();
        const { adapter, fireAndWait } = makeAdapter(stubSatoriApi(), spyResult);
        await adapter.start();
        await fireAndWait([
            makeRawMsg({
                elements: [{ elementType: 8, grayTipElement: { subElementType: 17 } }],
            }),
        ]);
        const bodies = eventBodies(spyResult.events);
        const last = bodies[bodies.length - 1];
        expect(last?.type).toBe("message-created");
    });

    it("成员变动在私聊会话：翻译 null → 不广播事件", async () => {
        const spyResult = spyBroadcaster();
        const { adapter, fireAndWait } = makeAdapter(stubSatoriApi(), spyResult);
        await adapter.start();
        await fireAndWait([
            makeMemberChangeMsg(
                { groupElement: { type: 1, memberUid: "m" } },
                { chatType: ChatType.C2C },
            ),
        ]);
        expect(eventBodies(spyResult.events)).toHaveLength(1); // 仅 login-updated
    });

    it("grayTip 翻译失败（uidToUin 拒绝）→ warn 留痕，不产生未处理拒绝", async () => {
        const spyResult = spyBroadcaster();
        const api = stubSatoriApi();
        const warn = vi.fn();
        vi.mocked(api.groupApi.uidToUin).mockRejectedValueOnce(new Error("转换失败"));
        const { adapter, fireAndWait } = makeAdapter(api, spyResult, {
            warn,
            info: vi.fn(),
            debug: vi.fn(),
        });
        await adapter.start();
        await fireAndWait([makeRevokeMsg()]);
        expect(eventBodies(spyResult.events)).toHaveLength(1); // 仅 login-updated，无事件
        // 失败留痕（warn 日志，非静默）
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[1]).toContain("grayTip 翻译失败");
        expect(warn.mock.calls[0]?.[0]).toMatchObject({ err: "转换失败" });
    });

    it("message-created 翻译失败（channel 类型回填抛错）→ warn 留痕，事件跳过", async () => {
        const spyResult = spyBroadcaster();
        const warn = vi.fn();
        const spy = vi.spyOn(SatoriApi.prototype, "setChannelType").mockImplementation(() => {
            throw new Error("回填失败");
        });
        const { adapter, fireAndWait } = makeAdapter(stubSatoriApi(), spyResult, {
            warn,
            info: vi.fn(),
            debug: vi.fn(),
        });
        await adapter.start();
        await fireAndWait([makeRawMsg()]);
        spy.mockRestore();
        const types = eventBodies(spyResult.events).map((e) => e.type);
        expect(types).not.toContain("message-created");
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[1]).toContain("消息翻译失败");
    });

    it("message-created 链路 at uid 转换失败 → at 原样 uid，事件照常广播", async () => {
        const spyResult = spyBroadcaster();
        const api = stubSatoriApi();
        vi.mocked(api.groupApi.uidToUin).mockRejectedValue(new Error("boom"));
        const { adapter, fireAndWait } = makeAdapter(api, spyResult);
        await adapter.start();
        await fireAndWait([
            makeRawMsg({
                elements: [
                    { elementType: 1, textElement: { content: "x", atType: 2, atUid: "u1" } },
                ],
            }),
        ]);
        const bodies = eventBodies(spyResult.events);
        const last = bodies[bodies.length - 1];
        expect(last?.type).toBe("message-created");
    });
});

describe("收链路补充分支（pickEventResources / 缓存回填兜底）", () => {
    it("私聊 message-created：guild/member 不写（undefined 分支）", async () => {
        const spyResult = spyBroadcaster();
        const { adapter, fireAndWait } = makeAdapter(stubSatoriApi(), spyResult);
        await adapter.start();
        await fireAndWait([makeRawMsg({ chatType: ChatType.C2C, peerUin: "90001", peerName: "" })]);
        const bodies = eventBodies(spyResult.events);
        const last = bodies[bodies.length - 1];
        expect(last?.type).toBe("message-created");
        expect(last?.guild).toBeUndefined();
        expect(last?.member).toBeUndefined();
        expect(last?.channel).toEqual({ id: "90001", type: 1, name: "小明" });
    });

    it("peerUin 缺失 → setChannelType 以空串回填（?? 兜底分支）", async () => {
        const spyResult = spyBroadcaster();
        const spy = vi.spyOn(SatoriApi.prototype, "setChannelType");
        const { adapter, fireAndWait } = makeAdapter(stubSatoriApi(), spyResult);
        await adapter.start();
        await fireAndWait([
            makeRawMsg({
                chatType: ChatType.C2C,
                peerUin: undefined as unknown as string,
            }),
        ]);
        expect(spy).toHaveBeenCalledWith("", false);
        spy.mockRestore();
    });

    it("撤回 operatorUid 为空串：不发起 uidToUin（uids 空 → 直接空映射）", async () => {
        const spyResult = spyBroadcaster();
        const api = stubSatoriApi();
        const { adapter, fireAndWait } = makeAdapter(api, spyResult);
        await adapter.start();
        await fireAndWait([makeRevokeMsg(undefined, "")]);
        const bodies = eventBodies(spyResult.events);
        const last = bodies[bodies.length - 1];
        expect(last?.type).toBe("message-deleted");
        expect(last?.operator).toEqual({ id: "" });
        // uid 收集为空：uidToUin 未被调用
        expect(api.groupApi.uidToUin).not.toHaveBeenCalled();
    });
});

describe("startTransports 完整装配（真实端口端到端）", () => {
    it("enabled 服务器：start 打开传输，HTTP RPC 与 login-updated 均可用；stop 关闭", async () => {
        const spyResult = spyBroadcaster();
        const api = stubSatoriApi();
        if (tmpRoot === "") {
            tmpRoot = mkdtempSync(join(tmpdir(), "nk-test-satori-adapter-"));
        }
        const { channel, fire } = fakeMsgChannel();
        const adapter = new NapukettoSatoriAdapter(
            stub<ConstructorParameters<typeof NapukettoSatoriAdapter>[0]>({
                msgApi: api.msgApi,
                groupApi: api.groupApi,
                groupNotifyApi: api.groupNotifyApi,
                friendApi: api.friendApi,
                profileApi: api.profileApi,
                self: api.self,
                cacheDir: api.cacheDir,
                config: new ConfigBase({
                    path: join(tmpRoot, "cfg-full.toml"),
                    schema: satoriConfigSchema,
                    defaults: satoriConfigSchema.parse({}),
                    seed: satoriConfigSchema.parse({
                        httpServers: [{ enabled: true, host: "127.0.0.1", port: 36251 }],
                        wsServers: [{ enabled: true, host: "127.0.0.1", port: 36252 }],
                    }),
                }),
                broadcaster: spyResult.broadcaster,
                msgChannel: channel,
            }),
        );

        await adapter.start();
        // login-updated（在线）已经广播
        const bodies = eventBodies(spyResult.events);
        expect(bodies[0]).toMatchObject({ type: "login-updated", sn: 1 });

        // HTTP RPC 经适配器动作注册表响应（currentLogin → login.get）
        const res = await fetch("http://127.0.0.1:36251/v1/login.get", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
        });
        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toMatchObject({ platform: "qq", status: 1 });

        // 消息事件仍可广播（sn 与 login-updated 连续递增）
        fire([makeRawMsg()]);
        await new Promise((resolve) => setImmediate(resolve));
        expect(eventBodies(spyResult.events)[1]).toMatchObject({ type: "message-created", sn: 2 });

        // WS READY 走适配器 login 回调（currentLogin）
        const ws = await openWs(36252);
        ws.send(JSON.stringify({ op: 3, body: {} }));
        const ready = await waitWsMessage(ws);
        expect(ready["op"]).toBe(4);
        ws.close();

        // 装配时注册 broadcaster，stop 时注销
        expect(spyResult.registered).toHaveLength(2);
        await adapter.stop();
        expect(spyResult.unregistered).toHaveLength(2);

        // stop：关闭传输（端口不再接受连接）
        await adapter.stop();
        await expect(
            fetch("http://127.0.0.1:36251/v1/login.get", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: "{}",
            }),
        ).rejects.toThrow();
    });

    it("subscribe 幂等守卫：已订阅时再次 subscribe 不重复注册", async () => {
        const spyResult = spyBroadcaster();
        const api = stubSatoriApi();
        const { channel } = fakeMsgChannel();
        const onSpy = vi.spyOn(channel, "on");
        const adapter = new NapukettoSatoriAdapter(
            stub<ConstructorParameters<typeof NapukettoSatoriAdapter>[0]>({
                msgApi: api.msgApi,
                groupApi: api.groupApi,
                groupNotifyApi: api.groupNotifyApi,
                friendApi: api.friendApi,
                profileApi: api.profileApi,
                self: api.self,
                cacheDir: api.cacheDir,
                config: new ConfigBase({
                    path: join(tmpRoot, "cfg-guard.toml"),
                    schema: satoriConfigSchema,
                    defaults: satoriConfigSchema.parse({}),
                    seed: satoriConfigSchema.parse({}),
                }),
                broadcaster: spyResult.broadcaster,
                msgChannel: channel,
            }),
        );
        await adapter.start();
        expect(onSpy).toHaveBeenCalledTimes(1);
        // 白盒：直接再调 subscribe（private，经类型断言访问），应命中幂等守卫
        (adapter as unknown as { subscribe: () => void }).subscribe();
        expect(onSpy).toHaveBeenCalledTimes(1);
    });
});
