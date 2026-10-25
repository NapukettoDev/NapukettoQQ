/**
 * adapter.test.ts：OB11 适配器 IPC 桥面单测（subscribeOnly/unsubscribeOnly/registry）。
 *
 * subscribeOnly（2026-08-27，IPC 桥模式）与 start() 的差别仅在传输层：
 * 只订阅消息通道（维护 messageUnique + 灰色通知），不装配 HTTP/WS。
 * kernel apis 以宽松桩对象注入（动作注册表构造期只持有引用，不调用）。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MsgEventChannel } from "@napuketto/kernel";
import { EventBroadcaster } from "@napuketto/network";
import { afterAll, describe, expect, it, vi } from "vitest";
import { ProtocolConfig } from "../core/index.js";
import { NapukettoOneBot11Adapter, type OneBot11AdapterOptions } from "./adapter.js";
import { ob11ConfigSchema } from "./helper/index.js";

/** 桩 kernel apis（构造期只持引用）。 */
function stubOptions(): Omit<OneBot11AdapterOptions, "config" | "broadcaster" | "msgChannel"> {
    return {
        msgApi: {},
        groupApi: {},
        groupNotifyApi: {},
        friendApi: {},
        ticketApi: {},
        richMediaApi: {},
        profileApi: {},
        profileLikeApi: {},
        webApi: {},
        self: { uin: "10001", nickname: "测试号" },
        system: { appVersion: "test" },
    } as unknown as Omit<OneBot11AdapterOptions, "config" | "broadcaster" | "msgChannel">;
}

/** 构造适配器（seed 配置——load() 返回内存初值，不读文件）。 */
function makeAdapter(channel: MsgEventChannel): NapukettoOneBot11Adapter {
    return new NapukettoOneBot11Adapter({
        ...stubOptions(),
        config: new ProtocolConfig({
            path: "ob11-test.toml",
            schema: ob11ConfigSchema,
            defaults: ob11ConfigSchema.parse({}),
            seed: ob11ConfigSchema.parse({}),
        }),
        broadcaster: new EventBroadcaster(),
        msgChannel: channel,
    });
}

/** 假消息通道（记录 on 调用，返回可控退订函数）。 */
function fakeChannel(): { channel: MsgEventChannel; off: ReturnType<typeof vi.fn> } {
    const off = vi.fn();
    const channel = { on: vi.fn(() => off) } as unknown as MsgEventChannel;
    return { channel, off };
}

/** 捕获 handler 的假通道（按事件名存取，测试手动触发）。 */
function captureChannel(): {
    channel: MsgEventChannel;
    handlers: Map<string, (...args: unknown[]) => void>;
} {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const channel = {
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
            handlers.set(event, handler);
            return () => handlers.delete(event);
        }),
    } as unknown as MsgEventChannel;
    return { channel, handlers };
}

describe("NapukettoOneBot11Adapter（IPC 桥面）", () => {
    it("subscribeOnly 订阅 Msg/onRecvMsg（幂等），unsubscribeOnly 退订", async () => {
        const { channel, off } = fakeChannel();
        const adapter = makeAdapter(channel);
        await adapter.subscribeOnly();
        // msgChannel 订阅集：onRecvMsg + offline_file/sys msg/在线文件（c3，2026-09-10）
        const msgSubs = 4;
        expect(channel.on).toHaveBeenCalledTimes(msgSubs);
        expect(channel.on).toHaveBeenCalledWith("Msg/onRecvMsg", expect.any(Function));
        expect(channel.on).toHaveBeenCalledWith("Msg/onRecvOfflineFileMsg", expect.any(Function));
        expect(channel.on).toHaveBeenCalledWith("Msg/onRecvSysMsg", expect.any(Function));
        expect(channel.on).toHaveBeenCalledWith("Msg/onRecvOnlineFileMsg", expect.any(Function));
        // 幂等：重复 subscribeOnly 不重复订阅
        await adapter.subscribeOnly();
        expect(channel.on).toHaveBeenCalledTimes(msgSubs);
        adapter.unsubscribeOnly();
        expect(off).toHaveBeenCalledTimes(msgSubs);
        // 退订后可重新订阅
        await adapter.subscribeOnly();
        expect(channel.on).toHaveBeenCalledTimes(msgSubs * 2);
    });

    it("registry 公开且动作名平铺可枚举（IPC 桥整表挂载依赖）", () => {
        const { channel } = fakeChannel();
        const adapter = makeAdapter(channel);
        const names = adapter.registry.names;
        expect(names.length).toBeGreaterThan(50);
        for (const name of ["send_like", "get_login_info", "set_group_ban", "send_private_msg"]) {
            expect(names).toContain(name);
            expect(adapter.registry.get(name)).toBeDefined();
        }
    });
});

describe("NapukettoOneBot11Adapter（request 事件链）", () => {
    /** 构造带群/好友通道的适配器（broadcaster emit 打桩捕获事件）。 */
    function makeWithRequestChannels(logger?: {
        warn(obj: unknown, msg?: string): void;
        info(obj: unknown, msg?: string): void;
        debug(obj: unknown, msg?: string): void;
    }): {
        adapter: NapukettoOneBot11Adapter;
        msg: ReturnType<typeof captureChannel>;
        group: ReturnType<typeof captureChannel>;
        friend: ReturnType<typeof captureChannel>;
        buddyCache: ReturnType<typeof captureChannel>;
        events: unknown[];
    } {
        const msg = captureChannel();
        const group = captureChannel();
        const friend = captureChannel();
        const buddyCache = captureChannel();
        const events: unknown[] = [];
        const broadcaster = { emit: (e: unknown) => events.push(e) } as unknown as EventBroadcaster;
        const adapter = new NapukettoOneBot11Adapter({
            ...stubOptions(),
            config: new ProtocolConfig({
                path: "ob11-test.toml",
                schema: ob11ConfigSchema,
                defaults: ob11ConfigSchema.parse({}),
                seed: ob11ConfigSchema.parse({}),
            }),
            broadcaster,
            msgChannel: msg.channel,
            groupChannel: group.channel as unknown as NonNullable<
                OneBot11AdapterOptions["groupChannel"]
            >,
            friendChannel: friend.channel as unknown as NonNullable<
                OneBot11AdapterOptions["friendChannel"]
            >,
            buddyCacheEvents: buddyCache.channel as unknown as NonNullable<
                OneBot11AdapterOptions["buddyCacheEvents"]
            >,
            ...(logger !== undefined ? { logger } : {}),
        });
        return { adapter, msg, group, friend, buddyCache, events };
    }

    it("subscribeOnly 订阅群通知与好友申请通道并广播 request 事件", async () => {
        const { adapter, group, friend, events } = makeWithRequestChannels();
        await adapter.subscribeOnly();
        expect(group.handlers.has("Group/onGroupNotifiesUpdated")).toBe(true);
        expect(friend.handlers.has("Buddy/onBuddyReqChange")).toBe(true);
        // 群通知（未处理申请）→ group request 事件
        group.handlers.get("Group/onGroupNotifiesUpdated")?.(false, [
            {
                seq: "7",
                type: 7,
                status: 1,
                group: { groupCode: "808", groupName: "g" },
                user1: { uid: "u1", nickName: "n" },
                postscript: "",
            },
        ]);
        await vi.waitFor(() => {
            expect(
                events.some((e) => (e as { request_type?: string }).request_type === "group"),
            ).toBe(true);
        });
        // 好友申请 → friend request 事件
        friend.handlers.get("Buddy/onBuddyReqChange")?.({
            buddyReqs: [{ reqTime: "1725800000", friendUid: "u1", words: "hi" }],
        });
        await vi.waitFor(() => {
            expect(
                events.some((e) => (e as { request_type?: string }).request_type === "friend"),
            ).toBe(true);
        });
    });

    it("onBuddyReqChange 未知参数形状静默跳过（校准 logger 可选）", async () => {
        const warn = vi.fn();
        const info = vi.fn();
        const debug = vi.fn();
        const { adapter, friend, events } = makeWithRequestChannels({ warn, info, debug });
        await adapter.subscribeOnly();
        friend.handlers.get("Buddy/onBuddyReqChange")?.({ unexpected: true });
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(warn).toHaveBeenCalledTimes(1);
        expect(events).toHaveLength(0);
    });

    it("buddyCacheEvents onBuddyAdded → friend_add 事件（B2）", async () => {
        const { adapter, buddyCache, events } = makeWithRequestChannels();
        await adapter.subscribeOnly();
        expect(buddyCache.handlers.has("BuddyCache/onBuddyAdded")).toBe(true);
        buddyCache.handlers.get("BuddyCache/onBuddyAdded")?.({
            uid: "u1",
            uin: "10086",
            coreInfo: { uid: "u1", uin: "10086", nick: "新好友" },
        });
        await vi.waitFor(() => {
            expect(
                events.some(
                    (e) =>
                        (e as { notice_type?: string }).notice_type === "friend_add" &&
                        (e as { user_id?: number }).user_id === 10086,
                ),
            ).toBe(true);
        });
    });

    it("doubt 可疑群通知跳过不广播", async () => {
        const { adapter, group, events } = makeWithRequestChannels();
        await adapter.subscribeOnly();
        group.handlers.get("Group/onGroupNotifiesUpdated")?.(true, [
            { seq: "1", type: 7, status: 1 },
        ]);
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(events).toHaveLength(0);
    });
});

describe("NapukettoOneBot11Adapter（reload 热更新，2026-09-08 T7）", () => {
    let tmpRoot = "";
    afterAll(() => {
        if (tmpRoot !== "") {
            rmSync(tmpRoot, { recursive: true, force: true });
        }
    });

    /** 文件型配置适配器（broadcaster emit 捕获，msgChannel 计数订阅）。 */
    function makeFileConfigAdapter(): {
        adapter: NapukettoOneBot11Adapter;
        events: Array<{ post_type?: string; sub_type?: string }>;
        onCalls: ReturnType<typeof vi.fn>;
        cfgPath: string;
    } {
        if (tmpRoot === "") {
            tmpRoot = mkdtempSync(join(tmpdir(), "napuketto-ob11-reload-"));
        }
        const cfgPath = join(tmpRoot, "ob11.toml");
        writeFileSync(cfgPath, "", "utf8");
        const events: Array<{ post_type?: string; sub_type?: string }> = [];
        const broadcaster = {
            emit: (e: unknown) => events.push(e as { post_type?: string; sub_type?: string }),
        } as unknown as EventBroadcaster;
        const onCalls = vi.fn(() => () => undefined);
        const adapter = new NapukettoOneBot11Adapter({
            ...stubOptions(),
            config: new ProtocolConfig({
                path: cfgPath,
                schema: ob11ConfigSchema,
                defaults: ob11ConfigSchema.parse({}),
            }),
            broadcaster,
            msgChannel: { on: onCalls } as unknown as MsgEventChannel,
        });
        return { adapter, events, onCalls, cfgPath };
    }

    it("reload 重建传输：lifecycle enable 二次广播 + 退订重订阅", async () => {
        const { adapter, events, onCalls, cfgPath } = makeFileConfigAdapter();
        await adapter.start();
        const enables = () =>
            events.filter((e) => e.post_type === "meta_event" && e.sub_type === "enable").length;
        // msgChannel 订阅集 4 个（onRecvMsg + c3 三通道，见 IPC 桥面用例）
        expect(enables()).toBe(1);
        expect(onCalls).toHaveBeenCalledTimes(4);

        // 配置变更 + reload → 传输重建（stop → start）
        writeFileSync(cfgPath, 'token = "changed"\n', "utf8");
        await adapter.reload();
        expect(enables()).toBe(2);
        expect(onCalls).toHaveBeenCalledTimes(8);
        await adapter.stop();
    });

    it("subscribeOnly（IPC 桥）reload 不重建传输，仅刷新上报开关", async () => {
        const { adapter, events } = makeFileConfigAdapter();
        await adapter.subscribeOnly();
        const before = events.length;
        await adapter.reload();
        // 无 lifecycle enable 广播（未走传输重建路径）
        expect(events.slice(before).filter((e) => e.post_type === "meta_event").length).toBe(0);
        adapter.unsubscribeOnly();
    });
});

describe("NapukettoOneBot11Adapter（group_upload 报形式开关，B4）", () => {
    /** 群文件消息（chatType=GROUP + fileElement）。 */
    function fileMsg(): Parameters<ReturnType<typeof captureChannel>["channel"]["on"]>[1] {
        return {
            msgId: "9100",
            msgSeq: "9",
            msgTime: "1700000000000",
            msgType: 2,
            chatType: 2,
            peerUid: "808",
            peerUin: "808",
            senderUid: "u9",
            senderUin: "90009",
            peerName: "群",
            sendNickName: "某人",
            elements: [
                {
                    elementType: 3,
                    fileElement: {
                        fileName: "doc.pdf",
                        fileSize: "1024",
                        fileUuid: "uuid-1",
                        filePath: "nt_data/File/doc.pdf",
                    },
                },
            ],
        } as unknown as Parameters<ReturnType<typeof captureChannel>["channel"]["on"]>[1];
    }

    function makeAdapter(seed: Record<string, unknown>) {
        const msg = captureChannel();
        const events: unknown[] = [];
        const broadcaster = { emit: (e: unknown) => events.push(e) } as unknown as EventBroadcaster;
        const adapter = new NapukettoOneBot11Adapter({
            ...stubOptions(),
            config: new ProtocolConfig({
                path: "ob11-test.toml",
                schema: ob11ConfigSchema,
                defaults: ob11ConfigSchema.parse({}),
                seed: ob11ConfigSchema.parse(seed),
            }),
            broadcaster,
            msgChannel: msg.channel,
        });
        return { adapter, msg, events };
    }

    it("off（默认）：message 事件 + file 段透出（此前被静默丢弃）", async () => {
        const { adapter, msg, events } = makeAdapter({});
        await adapter.subscribeOnly();
        msg.handlers.get("Msg/onRecvMsg")?.([fileMsg()]);
        await vi.waitFor(() => {
            expect(events).toHaveLength(1);
        });
        const event = events[0] as {
            post_type: string;
            message: Array<{ type: string; data: Record<string, unknown> }>;
        };
        expect(event.post_type).toBe("message");
        expect(event.message.some((s) => s.type === "file" && s.data["file"] === "doc.pdf")).toBe(
            true,
        );
    });

    it("on：group_upload notice 替代 message 事件", async () => {
        const { adapter, msg, events } = makeAdapter({ groupUploadAsNotice: true });
        await adapter.subscribeOnly();
        msg.handlers.get("Msg/onRecvMsg")?.([fileMsg()]);
        await vi.waitFor(() => {
            expect(events).toHaveLength(1);
        });
        expect(events[0]).toMatchObject({
            post_type: "notice",
            notice_type: "group_upload",
            group_id: 808,
            user_id: 90009,
            file: { id: "uuid-1", name: "doc.pdf", size: 1024, busid: 102 },
        });
    });

    it("on 但非文件消息：仍走 message 事件", async () => {
        const { adapter, msg, events } = makeAdapter({ groupUploadAsNotice: true });
        await adapter.subscribeOnly();
        msg.handlers.get("Msg/onRecvMsg")?.([
            {
                ...fileMsg(),
                elements: [{ elementType: 1, textElement: { content: "普通消息" } }],
            },
        ]);
        await vi.waitFor(() => {
            expect(events).toHaveLength(1);
        });
        expect((events[0] as { post_type: string }).post_type).toBe("message");
    });
});

describe("NapukettoOneBot11Adapter（sysmsg 解码链，design.md §7）", () => {
    /** varint 编码（合成 sysmsg 用）。 */
    function encVarint(v: number): number[] {
        const out: number[] = [];
        while (true) {
            const b = v & 0x7f;
            v >>>= 7;
            if (v === 0) {
                out.push(b);
                return out;
            }
            out.push(b | 0x80);
        }
    }

    /** 合成 528/382 sysmsg 字节（已观测未命名类型；顶层 f2{f1,f2,f3}）。 */
    function blob528(): number[] {
        const f2 = [
            0x08,
            ...encVarint(528), // f1: msgType
            0x10,
            ...encVarint(382), // f2: subType
            0x18,
            ...encVarint(382), // f3: subTypeAlt
        ];
        return [0x12, ...encVarint(f2.length), ...f2]; // 顶层 f2（length-delimited）
    }

    function makeSysMsgHarness(): {
        adapter: NapukettoOneBot11Adapter;
        msg: ReturnType<typeof captureChannel>;
        events: unknown[];
        warn: ReturnType<typeof vi.fn>;
        info: ReturnType<typeof vi.fn>;
        debug: ReturnType<typeof vi.fn>;
    } {
        const msg = captureChannel();
        const events: unknown[] = [];
        const warn = vi.fn();
        const info = vi.fn();
        const debug = vi.fn();
        const adapter = new NapukettoOneBot11Adapter({
            ...stubOptions(),
            config: new ProtocolConfig({
                path: "ob11-test.toml",
                schema: ob11ConfigSchema,
                defaults: ob11ConfigSchema.parse({}),
                seed: ob11ConfigSchema.parse({}),
            }),
            broadcaster: { emit: (e: unknown) => events.push(e) } as unknown as EventBroadcaster,
            msgChannel: msg.channel,
            logger: { warn, info, debug },
        });
        return { adapter, msg, events, warn, info, debug };
    }

    it("528/382 sysmsg 批：解码成功但不广播，校准日志降 debug（识别表空）", async () => {
        const { adapter, msg, events, warn, info, debug } = makeSysMsgHarness();
        await adapter.subscribeOnly();
        msg.handlers.get("Msg/onRecvSysMsg")?.([[...blob528()]]);
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(events).toHaveLength(0);
        expect(warn).not.toHaveBeenCalled();
        // 2026-10-25 级别重分配：校准遥测 info → debug（info 级不再出现）
        expect(info).not.toHaveBeenCalled();
        expect(debug).toHaveBeenCalledTimes(1);
        const payload = debug.mock.calls[0]?.[0] as { verdict?: string; msgType?: number };
        expect(payload.verdict).toBe("observed_unnamed");
        expect(payload.msgType).toBe(528);
    });

    it("未知参数形状 → warn（raw 截断）且不广播", async () => {
        const { adapter, msg, events, warn } = makeSysMsgHarness();
        await adapter.subscribeOnly();
        // 长 payload（> 64 字符）触发 warn 级截断
        msg.handlers.get("Msg/onRecvSysMsg")?.({ unexpected: "x".repeat(200) });
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(warn).toHaveBeenCalledTimes(1);
        const payload = warn.mock.calls[0]?.[0] as { raw?: string };
        // warn 级 raw 截断：64 字符前缀 + …(+N) 标注
        expect(payload.raw).toMatch(/^.{1,64}…\(\+\d+\)$/);
        expect(events).toHaveLength(0);
    });

    it("合法字节块但 wire 畸形 → 解码失败 warn 且不广播", async () => {
        const { adapter, msg, events, warn, info, debug } = makeSysMsgHarness();
        await adapter.subscribeOnly();
        msg.handlers.get("Msg/onRecvSysMsg")?.([[0x00]]); // field 0 顶层非法
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(warn).toHaveBeenCalledTimes(1);
        expect(info).not.toHaveBeenCalled();
        expect(debug).not.toHaveBeenCalled();
        expect(events).toHaveLength(0);
    });
});
