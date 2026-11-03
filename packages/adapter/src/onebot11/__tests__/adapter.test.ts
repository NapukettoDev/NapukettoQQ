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
import type { GroupEventChannel, MsgEventChannel } from "@napuketto/kernel";
import { EventBroadcaster } from "@napuketto/network";
import { afterAll, describe, expect, it, vi } from "vitest";
import { ProtocolConfig } from "../../core/index.js";
import { NapukettoOneBot11Adapter, type OneBot11AdapterOptions } from "../adapter.js";
import { ob11ConfigSchema } from "../helper/index.js";

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

describe("NapukettoOneBot11Adapter（group_essence 事件链，design.md §1）", () => {
    /** EssenceMsgItem 桩（webapi getEssenceMsgList 项）。 */
    const essenceItem = (seq: number, adder: string, sender = "10001") => ({
        msg_seq: seq,
        msg_random: seq,
        sender_uin: sender,
        sender_nick: "s",
        add_digest_uin: adder,
        add_digest_nick: "op",
        add_digest_time: 1793540100,
        msg_content: [],
    });

    /** 合成 732:1 sysmsg 字节（精华设置；f1.f1=群号 + f1.f8.f8.f1=msgSeq，识别表实证路径）。 */
    function essenceBlob(): number[] {
        const inner = [0x08, ...encVarintOf(150)]; // f8.f1 = msgSeq
        const mid = [0x42, inner.length, ...inner]; // f8（length-delimited）
        const f1 = [0x08, ...encVarintOf(1101729931), 0x42, mid.length, ...mid]; // f1.f1 群号 + f1.f8
        const f2 = [0x08, ...encVarintOf(732), 0x10, ...encVarintOf(1)]; // msgType/subType
        return [
            0x0a,
            f1.length,
            ...f1, // 顶层 f1
            0x12,
            f2.length,
            ...f2, // 顶层 f2
        ];
    }

    /** 合成 732:1 畸形样本（缺 f1 群号路径 → 触发器抽取失败）。 */
    function bareEssenceBlob(): number[] {
        const f2 = [0x08, ...encVarintOf(732), 0x10, ...encVarintOf(1)];
        return [0x12, f2.length, ...f2];
    }

    /** varint 编码（合成 sysmsg 用，返回字节数组）。 */
    function encVarintOf(v: number): number[] {
        const out: number[] = [];
        let value = v;
        while (true) {
            const b = value & 0x7f;
            value >>>= 7;
            if (value === 0) {
                out.push(b);
                return out;
            }
            out.push(b | 0x80);
        }
    }

    /** 精华链 harness：msg + group 通道捕获，webApi/msgApi 可控桩。 */
    function makeEssenceHarness(): {
        adapter: NapukettoOneBot11Adapter;
        msg: ReturnType<typeof captureChannel>;
        group: ReturnType<typeof captureChannel>;
        events: Record<string, unknown>[];
        warn: ReturnType<typeof vi.fn>;
        debug: ReturnType<typeof vi.fn>;
        getEssenceList: ReturnType<typeof vi.fn>;
        fetchMsgs: ReturnType<typeof vi.fn>;
    } {
        const msg = captureChannel();
        const group = captureChannel();
        const events: Record<string, unknown>[] = [];
        const warn = vi.fn();
        const info = vi.fn();
        const debug = vi.fn();
        const getEssenceList = vi.fn(async (_group: string): Promise<unknown[]> => []);
        const fetchMsgs = vi.fn(async (_peer: unknown, _opts: unknown): Promise<unknown[]> => []);
        const options = {
            ...stubOptions(),
            webApi: { getEssenceMsgList: getEssenceList },
            msgApi: { fetchMessages: fetchMsgs },
        } as unknown as ReturnType<typeof stubOptions>;
        const adapter = new NapukettoOneBot11Adapter({
            ...options,
            config: new ProtocolConfig({
                path: "ob11-test.toml",
                schema: ob11ConfigSchema,
                defaults: ob11ConfigSchema.parse({}),
                seed: ob11ConfigSchema.parse({}),
            }),
            broadcaster: {
                emit: (e: unknown) => events.push(e as Record<string, unknown>),
            } as unknown as EventBroadcaster,
            msgChannel: msg.channel,
            groupChannel: group.channel as unknown as GroupEventChannel,
            logger: { warn, info, debug },
        });
        return { adapter, msg, group, events, warn, debug, getEssenceList, fetchMsgs };
    }

    it("列表回调：首个事件只建基线；新增项 → add 广播（operator/sender/message_id 全字段）", async () => {
        const { adapter, group, events, getEssenceList, fetchMsgs } = makeEssenceHarness();
        await adapter.subscribeOnly();
        getEssenceList.mockResolvedValue([essenceItem(150, "10002")]);
        group.handlers.get("Group/onGroupEssenceListChange")?.(["1101729931"]);
        await vi.waitFor(() => {
            expect(getEssenceList).toHaveBeenCalledTimes(1);
        });
        expect(events).toHaveLength(0); // 基线不广播

        getEssenceList.mockResolvedValue([essenceItem(150, "10002"), essenceItem(151, "10003")]);
        fetchMsgs.mockResolvedValue([{ msgId: "nt-151", msgSeq: "151" }]);
        group.handlers.get("Group/onGroupEssenceListChange")?.(["1101729931"]);
        await vi.waitFor(() => {
            expect(events).toHaveLength(1);
        });
        expect(events[0]).toMatchObject({
            post_type: "notice",
            notice_type: "group_essence",
            sub_type: "add",
            group_id: 1101729931,
            sender_id: 10001,
            operator_id: 10003,
            time: 1793540100,
        });
        const messageId = (events[0] as { message_id?: number }).message_id;
        expect(typeof messageId).toBe("number");
        expect(messageId).toBeGreaterThan(0);
    });

    it("732:1 触发器与列表回调汇入同一串行链：不重复广播", async () => {
        const { adapter, msg, group, events, getEssenceList, fetchMsgs } = makeEssenceHarness();
        await adapter.subscribeOnly();
        getEssenceList.mockResolvedValue([essenceItem(150, "10002")]);
        fetchMsgs.mockResolvedValue([{ msgId: "nt-150", msgSeq: "150" }]);
        // 首触（732:1）→ 基线
        msg.handlers.get("Msg/onRecvSysMsg")?.([[...essenceBlob()]]);
        await vi.waitFor(() => {
            expect(getEssenceList).toHaveBeenCalledTimes(1);
        });
        expect(events).toHaveLength(0);
        // 次触（列表回调，列表已含 150）→ diff 空，不重发
        group.handlers.get("Group/onGroupEssenceListChange")?.(["1101729931"]);
        await vi.waitFor(() => {
            expect(getEssenceList).toHaveBeenCalledTimes(2);
        });
        expect(events).toHaveLength(0);
        // 三触（列表新增 151）→ add 广播一次
        getEssenceList.mockResolvedValue([essenceItem(150, "10002"), essenceItem(151, "10002")]);
        fetchMsgs.mockResolvedValue([{ msgId: "nt-151", msgSeq: "151" }]);
        group.handlers.get("Group/onGroupEssenceListChange")?.(["1101729931"]);
        await vi.waitFor(() => {
            expect(events).toHaveLength(1);
        });
    });

    it("移除项 → delete 广播（sender 从 prev 缓存回填，operator 省略）", async () => {
        const { adapter, group, events, getEssenceList, fetchMsgs } = makeEssenceHarness();
        await adapter.subscribeOnly();
        getEssenceList.mockResolvedValue([essenceItem(150, "10002"), essenceItem(151, "10003")]);
        group.handlers.get("Group/onGroupEssenceListChange")?.(["1101729931"]);
        await vi.waitFor(() => {
            expect(getEssenceList).toHaveBeenCalledTimes(1);
        });
        fetchMsgs.mockResolvedValue([{ msgId: "nt-150", msgSeq: "150" }]);
        getEssenceList.mockResolvedValue([essenceItem(151, "10003")]);
        group.handlers.get("Group/onGroupEssenceListChange")?.(["1101729931"]);
        await vi.waitFor(() => {
            expect(events).toHaveLength(1);
        });
        expect(events[0]).toMatchObject({
            notice_type: "group_essence",
            sub_type: "delete",
            group_id: 1101729931,
            sender_id: 10001,
            message_id: expect.any(Number),
        });
        expect("operator_id" in (events[0] as object)).toBe(false);
    });

    it("message_id 反查未命中 → 跳过事件 + warn 校准", async () => {
        const { adapter, group, events, warn, getEssenceList } = makeEssenceHarness();
        await adapter.subscribeOnly();
        getEssenceList.mockResolvedValue([essenceItem(150, "10002")]);
        group.handlers.get("Group/onGroupEssenceListChange")?.(["1101729931"]);
        await vi.waitFor(() => {
            expect(getEssenceList).toHaveBeenCalledTimes(1);
        });
        getEssenceList.mockResolvedValue([essenceItem(150, "10002"), essenceItem(999, "10002")]);
        // fetchMsgs 桩默认返回空 → 近段扫描未命中
        group.handlers.get("Group/onGroupEssenceListChange")?.(["1101729931"]);
        await vi.waitFor(() => {
            expect(warn).toHaveBeenCalled();
        });
        expect(events).toHaveLength(0);
        expect(
            warn.mock.calls.some((call) => String(call[1]).includes("message_id 反查未命中")),
        ).toBe(true);
    });

    it("sender_uin 缺失 → 跳过事件 + warn 校准", async () => {
        const { adapter, group, events, warn, getEssenceList } = makeEssenceHarness();
        await adapter.subscribeOnly();
        getEssenceList.mockResolvedValue([essenceItem(150, "10002")]);
        group.handlers.get("Group/onGroupEssenceListChange")?.(["1101729931"]);
        await vi.waitFor(() => {
            expect(getEssenceList).toHaveBeenCalledTimes(1);
        });
        getEssenceList.mockResolvedValue([
            essenceItem(150, "10002"),
            essenceItem(151, "10002", ""),
        ]);
        group.handlers.get("Group/onGroupEssenceListChange")?.(["1101729931"]);
        await vi.waitFor(() => {
            expect(warn).toHaveBeenCalled();
        });
        expect(events).toHaveLength(0);
    });

    it("精华列表拉取失败 → warn 校准，无事件", async () => {
        const { adapter, group, events, warn, getEssenceList } = makeEssenceHarness();
        await adapter.subscribeOnly();
        getEssenceList.mockRejectedValue(new Error("cgi down"));
        group.handlers.get("Group/onGroupEssenceListChange")?.(["1101729931"]);
        await vi.waitFor(() => {
            expect(warn).toHaveBeenCalled();
        });
        expect(events).toHaveLength(0);
    });

    it("732:1 触发器抽取失败（畸形样本）→ 落入 unknown 校准路径", async () => {
        const { adapter, msg, events, warn, debug, getEssenceList } = makeEssenceHarness();
        await adapter.subscribeOnly();
        msg.handlers.get("Msg/onRecvSysMsg")?.([[...bareEssenceBlob()]]);
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(getEssenceList).not.toHaveBeenCalled();
        expect(events).toHaveLength(0);
        expect(warn).not.toHaveBeenCalled();
        expect(debug).toHaveBeenCalledTimes(1);
        const payload = debug.mock.calls[0]?.[0] as { verdict?: string };
        expect(payload.verdict).toBe("unknown");
    });
});
