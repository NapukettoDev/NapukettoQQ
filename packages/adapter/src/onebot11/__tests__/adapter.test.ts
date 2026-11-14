/**
 * adapter.test.ts：OB11 适配器单测（IPC 桥面 + 消息/notice/sysmsg/群请求/精华
 * 事件链分支 + 传输装配跳过分支）。
 *
 * subscribeOnly（IPC 桥模式）与 start 的差别仅在传输层：
 * 只订阅消息通道（维护 messageUnique + 灰色通知），不装配 HTTP/WS。
 * kernel apis 以宽松桩对象注入（动作注册表构造期只持有引用，不调用）。
 * 自 adapter-branches / adapter-extra 并入：私聊与 role 注入、grayTip/sysmsg
 * 校准日志、精华串行链 rejection 恢复、at/reply ID 转换、broadcaster 缺省等分支。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    ChatType,
    type EssenceMsgItem,
    type FriendApi,
    type GroupApi,
    type GroupEventChannel,
    type GroupNotify,
    type GroupNotifyApi,
    type MsgApi,
    type MsgEventChannel,
    NTGroupMemberRole,
    type Peer,
    type ProfileApi,
    type ProfileLikeApi,
    type RawMessage,
    type RichMediaApi,
    type TicketApi,
    type WebApi,
} from "@napuketto/kernel";
import { EventBroadcaster } from "@napuketto/network";
import { afterAll, describe, expect, it, vi } from "vitest";
import { ConfigBase } from "../../core/index.js";
import { stub } from "../../shared/__tests__/stub.js";
import {
    type AdapterLoggerLike,
    NapukettoOneBot11Adapter,
    type OneBot11AdapterOptions,
} from "../adapter.js";

import { ob11ConfigSchema } from "../helper/index.js";

/** 桩 kernel apis（构造期只持引用；可注入覆盖）。 */
function stubOptions(
    overrides?: Record<string, unknown>,
): Omit<OneBot11AdapterOptions, "config" | "broadcaster" | "msgChannel"> {
    return stub<Omit<OneBot11AdapterOptions, "config" | "broadcaster" | "msgChannel">>({
        msgApi: stub<MsgApi>({}),
        groupApi: stub<GroupApi>({}),
        groupNotifyApi: stub<GroupNotifyApi>({}),
        friendApi: stub<FriendApi>({}),
        ticketApi: stub<TicketApi>({}),
        richMediaApi: stub<RichMediaApi>({}),
        profileApi: stub<ProfileApi>({}),
        profileLikeApi: stub<ProfileLikeApi>({}),
        webApi: stub<WebApi>({}),
        self: { uin: "10001", nickname: "测试号" },
        system: { appVersion: "test" },
        ...overrides,
    });
}

/** 构造适配器（seed 配置——load() 返回内存初值，不读文件）。 */
function makeAdapter(channel: MsgEventChannel): NapukettoOneBot11Adapter {
    return new NapukettoOneBot11Adapter({
        ...stubOptions(),
        config: new ConfigBase({
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
    const channel = stub<MsgEventChannel>({ on: vi.fn(() => off) });
    return { channel, off };
}

/** 捕获 handler 的假通道（按事件名存取，测试手动触发；off 为退订计数桩）。 */
function captureChannel(): {
    channel: MsgEventChannel;
    handlers: Map<string, (...args: unknown[]) => void>;
    off: ReturnType<typeof vi.fn>;
} {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const off = vi.fn();
    const channel = stub<MsgEventChannel>({
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
            handlers.set(event, handler);
            return off;
        }),
    });
    return { channel, handlers, off };
}

describe("NapukettoOneBot11Adapter（IPC 桥面）", () => {
    it("subscribeOnly 订阅 Msg/onRecvMsg（幂等），unsubscribeOnly 退订", async () => {
        const { channel, off } = fakeChannel();
        const adapter = makeAdapter(channel);
        await adapter.subscribeOnly();
        // msgChannel 订阅集：onRecvMsg + offline_file/sys msg/在线文件（c3）
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
        const broadcaster = stub<EventBroadcaster>({ emit: (e: unknown) => events.push(e) });
        const adapter = new NapukettoOneBot11Adapter({
            ...stubOptions(),
            config: new ConfigBase({
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

    it("buddyCacheEvents onBuddyAdded → friend_add 事件（）", async () => {
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

describe("NapukettoOneBot11Adapter（reload 热更新）", () => {
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
        const broadcaster = stub<EventBroadcaster>({
            emit: (e: unknown) => events.push(e as { post_type?: string; sub_type?: string }),
        });
        const onCalls = vi.fn(() => () => undefined);
        const adapter = new NapukettoOneBot11Adapter({
            ...stubOptions(),
            config: new ConfigBase({
                path: cfgPath,
                schema: ob11ConfigSchema,
                defaults: ob11ConfigSchema.parse({}),
            }),
            broadcaster,
            msgChannel: stub<MsgEventChannel>({ on: onCalls }),
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

describe("NapukettoOneBot11Adapter（group_upload 报形式开关）", () => {
    /** 群文件消息（chatType=GROUP + fileElement）。 */
    function fileMsg(): Parameters<ReturnType<typeof captureChannel>["channel"]["on"]>[1] {
        return stub<Parameters<ReturnType<typeof captureChannel>["channel"]["on"]>[1]>({
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
        });
    }

    function makeAdapter(seed: Record<string, unknown>) {
        const msg = captureChannel();
        const events: unknown[] = [];
        const broadcaster = stub<EventBroadcaster>({ emit: (e: unknown) => events.push(e) });
        const adapter = new NapukettoOneBot11Adapter({
            ...stubOptions(),
            config: new ConfigBase({
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
            config: new ConfigBase({
                path: "ob11-test.toml",
                schema: ob11ConfigSchema,
                defaults: ob11ConfigSchema.parse({}),
                seed: ob11ConfigSchema.parse({}),
            }),
            broadcaster: stub<EventBroadcaster>({ emit: (e: unknown) => events.push(e) }),
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
        // 级别重分配：校准遥测 info → debug（info 级不再出现）
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
        const getEssenceList = vi.fn(async (_group: string): Promise<EssenceMsgItem[]> => []);
        const fetchMsgs = vi.fn(async (_peer: Peer, _opts: unknown): Promise<RawMessage[]> => []);
        const options = stub<ReturnType<typeof stubOptions>>({
            ...stubOptions(),
            webApi: stub<WebApi>({ getEssenceMsgList: getEssenceList }),
            msgApi: stub<MsgApi>({ fetchMessages: fetchMsgs }),
        });
        const adapter = new NapukettoOneBot11Adapter({
            ...options,
            config: new ConfigBase({
                path: "ob11-test.toml",
                schema: ob11ConfigSchema,
                defaults: ob11ConfigSchema.parse({}),
                seed: ob11ConfigSchema.parse({}),
            }),
            broadcaster: stub<EventBroadcaster>({
                emit: (e: unknown) => events.push(e as Record<string, unknown>),
            }),
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

    it("add_digest_uin 缺失 → add 事件省略 operator_id；fetchMessages 命中反查", async () => {
        const { adapter, group, events, getEssenceList, fetchMsgs } = makeEssenceHarness();
        await adapter.subscribeOnly();
        getEssenceList.mockResolvedValue([essenceItem(150, "10002")]);
        group.handlers.get("Group/onGroupEssenceListChange")?.(["1101729931"]);
        await vi.waitFor(() => {
            expect(getEssenceList).toHaveBeenCalledTimes(1);
        });
        // 新增项无加精操作者（add_digest_uin 空串）→ operator_id 无数据源省略
        getEssenceList.mockResolvedValue([essenceItem(150, "10002"), essenceItem(151, "")]);
        fetchMsgs.mockResolvedValue([{ msgId: "nt-151", msgSeq: "151" }]);
        group.handlers.get("Group/onGroupEssenceListChange")?.(["1101729931"]);
        await vi.waitFor(() => {
            expect(events).toHaveLength(1);
        });
        const event = events[0] as Record<string, unknown>;
        expect(event["sub_type"]).toBe("add");
        expect(event["sender_id"]).toBe(10001);
        expect("operator_id" in event).toBe(false);
        expect(typeof event["message_id"]).toBe("number");
    });

    it("add_digest_time 缺失（0 → null）→ add 事件 time 取当前时刻兜底", async () => {
        const { adapter, group, events, getEssenceList, fetchMsgs } = makeEssenceHarness();
        await adapter.subscribeOnly();
        getEssenceList.mockResolvedValue([essenceItem(150, "10002")]);
        group.handlers.get("Group/onGroupEssenceListChange")?.(["1101729931"]);
        await vi.waitFor(() => {
            expect(getEssenceList).toHaveBeenCalledTimes(1);
        });
        // add_digest_time = 0 → diff 层归一为 null → time 兜底 Date.now()/1000
        const beforeSec = Math.floor(Date.now() / 1000);
        getEssenceList.mockResolvedValue([
            { ...essenceItem(150, "10002"), add_digest_time: 0 },
            { ...essenceItem(151, "10003"), add_digest_time: 0 },
        ]);
        fetchMsgs.mockResolvedValue([{ msgId: "nt-151", msgSeq: "151" }]);
        group.handlers.get("Group/onGroupEssenceListChange")?.(["1101729931"]);
        await vi.waitFor(() => {
            expect(events).toHaveLength(1);
        });
        const afterSec = Math.floor(Date.now() / 1000);
        const time = (events[0] as { time?: number }).time as number;
        expect(time).toBeGreaterThanOrEqual(beforeSec);
        expect(time).toBeLessThanOrEqual(afterSec);
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

/** 构造适配器（seed 配置；broadcaster emit 捕获事件数组。broadcaster=null = 不传广播器）。 */
function makeEventAdapter(options?: {
    seed?: Record<string, unknown>;
    overrides?: Record<string, unknown>;
    logger?: AdapterLoggerLike;
    broadcaster?: EventBroadcaster | null;
    groupChannel?: GroupEventChannel;
}): {
    adapter: NapukettoOneBot11Adapter;
    events: Record<string, unknown>[];
    msg: ReturnType<typeof captureChannel>;
} {
    const msg = captureChannel();
    const events: Record<string, unknown>[] = [];
    // broadcaster：null = 显式缺省（BaseProtocolAdapter 允许 undefined）；缺省 = emit 捕获桩
    let broadcaster: EventBroadcaster | undefined;
    if (options?.broadcaster === null) {
        broadcaster = undefined;
    } else if (options?.broadcaster === undefined) {
        broadcaster = stub<EventBroadcaster>({
            emit: (e: unknown) => events.push(e as Record<string, unknown>),
            register: () => undefined,
            unregister: () => undefined,
        });
    } else {
        broadcaster = options.broadcaster;
    }
    const adapter = new NapukettoOneBot11Adapter({
        ...stubOptions(options?.overrides),
        config: new ConfigBase({
            path: "ob11-test.toml",
            schema: ob11ConfigSchema,
            defaults: ob11ConfigSchema.parse({}),
            seed: ob11ConfigSchema.parse(options?.seed ?? {}),
        }),
        broadcaster: broadcaster as EventBroadcaster, // null → 运行时 undefined（装配跳过分支）
        msgChannel: msg.channel,
        ...(options?.groupChannel !== undefined ? { groupChannel: options.groupChannel } : {}),
        ...(options?.logger !== undefined ? { logger: options.logger } : {}),
    });
    return { adapter, events, msg };
}

/** 文本消息（chatType 可覆盖；元素 = 单 text）。 */
function textMsg(chatType: number): Record<string, unknown> {
    return {
        msgId: "nt-text",
        msgSeq: "5",
        msgTime: "1700000000000",
        chatType,
        peerUid: "808",
        senderUin: "90009",
        senderUid: "u90009",
        sendNickName: "某人",
        elements: [{ elementType: 1, textElement: { content: "你好" } }],
    };
}

describe("消息事件分支（broadcastMessageEvent）", () => {
    it("C2C 私聊文本 → private 事件（sub_type=friend，sender 无 role 字段）", async () => {
        const { adapter, msg, events } = makeEventAdapter();
        await adapter.subscribeOnly();
        msg.handlers.get("Msg/onRecvMsg")?.([textMsg(ChatType.C2C)]);
        await vi.waitFor(() => {
            expect(events).toHaveLength(1);
        });
        const event = events[0] as {
            message_type?: string;
            sub_type?: string;
            sender?: Record<string, unknown>;
        };
        expect(event.message_type).toBe("private");
        expect(event.sub_type).toBe("friend");
        expect(event.sender).toMatchObject({ user_id: 90009, nickname: "某人" });
        // 私聊 sender 不带 role（senderRole 仅群消息注入）
        expect("role" in (event.sender as object)).toBe(false);
        adapter.unsubscribeOnly();
    });

    it("groupCache 命中群主 → sender.role=owner 注入群消息事件", async () => {
        const groupCache = {
            getMember: vi.fn(async () => ({
                uid: "u90009",
                uin: "90009",
                nick: "某人",
                role: NTGroupMemberRole.OWNER,
            })),
        };
        const { adapter, msg, events } = makeEventAdapter({ overrides: { groupCache } });
        await adapter.subscribeOnly();
        msg.handlers.get("Msg/onRecvMsg")?.([textMsg(ChatType.GROUP)]);
        await vi.waitFor(() => {
            expect(events).toHaveLength(1);
        });
        expect(events[0]).toMatchObject({
            message_type: "group",
            sender: { user_id: 90009, role: "owner" },
        });
        expect(groupCache.getMember).toHaveBeenCalledWith("808", "u90009");
        adapter.unsubscribeOnly();
    });
});

describe("grayTip notice 分支（broadcastNotice）", () => {
    it("校准 logger 注入翻译上下文：群撤回事件照常广播", async () => {
        const warn = vi.fn();
        const { adapter, msg, events } = makeEventAdapter({
            overrides: {
                groupApi: { uidToUin: vi.fn(async () => new Map([["u90009", "90009"]])) },
            },
            logger: { warn, info: vi.fn(), debug: vi.fn() },
        });
        await adapter.subscribeOnly();
        msg.handlers.get("Msg/onRecvMsg")?.([
            {
                ...textMsg(ChatType.GROUP),
                msgId: "nt-revoke",
                elements: [
                    {
                        elementType: 8,
                        grayTipElement: {
                            subElementType: 1,
                            revokeElement: { operatorUid: "u90009" },
                        },
                    },
                ],
            },
        ]);
        await vi.waitFor(() => {
            expect(events.some((e) => e["notice_type"] === "group_recall")).toBe(true);
        });
        // 翻译成功不走校准日志
        expect(warn).not.toHaveBeenCalled();
        adapter.unsubscribeOnly();
    });

    it("未知 grayTip 子类型（JSON）→ collectGrayTipUids 空 + 事件 null：不广播且 warn 校准", async () => {
        const warn = vi.fn();
        const uidToUin = vi.fn(async () => new Map<string, string>());
        const { adapter, msg, events } = makeEventAdapter({
            overrides: { groupApi: { uidToUin } },
            logger: { warn, info: vi.fn(), debug: vi.fn() },
        });
        await adapter.subscribeOnly();
        msg.handlers.get("Msg/onRecvMsg")?.([
            {
                ...textMsg(ChatType.GROUP),
                msgId: "nt-json-tip",
                elements: [
                    {
                        elementType: 8,
                        grayTipElement: { subElementType: 17, jsonGrayTipElement: {} },
                    },
                ],
            },
        ]);
        await new Promise((resolve) => setTimeout(resolve, 10));
        // 无 uid 可转（collectGrayTipUids 短路分支）+ 翻译 null（不广播）
        expect(uidToUin).not.toHaveBeenCalled();
        expect(events).toHaveLength(0);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[1]).toContain("未翻译的 grayTip 子类型");
        adapter.unsubscribeOnly();
    });
});

describe("sysmsg 分支（truncRaw / uidToUin 兜底）", () => {
    it("onRecvSysMsg(undefined) → JSON.stringify(undefined) → warn 的 raw 为空串", async () => {
        const warn = vi.fn();
        const { adapter, msg } = makeEventAdapter({
            logger: { warn, info: vi.fn(), debug: vi.fn() },
        });
        await adapter.subscribeOnly();
        msg.handlers.get("Msg/onRecvSysMsg")?.(undefined);
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[0]).toEqual({ raw: "" });
        expect(warn.mock.calls[0]?.[1]).toContain("onRecvSysMsg 未知参数形状");
        adapter.unsubscribeOnly();
    });

    it("group_card：card_new/card_old 缺失 → 空串兜底", async () => {
        const groupApi = {
            uidToUin: vi.fn(async () => new Map([["u_90002", "90002"]])),
        };
        const { adapter, msg, events } = makeEventAdapter({ overrides: { groupApi } });
        await adapter.subscribeOnly();
        // 只有 [群号, uid] 两个串 → 新旧名片缺失
        msg.handlers.get("Msg/onRecvSysMsg")?.([[...cardBlob2("1101729931", "u_90002")]]);
        await vi.waitFor(() => {
            expect(events.some((e) => e["notice_type"] === "group_card")).toBe(true);
        });
        expect(events.find((e) => e["notice_type"] === "group_card")).toMatchObject({
            group_id: 1101729931,
            user_id: 90002,
            card_new: "",
            card_old: "",
        });
        adapter.unsubscribeOnly();
    });

    it("group_card：uidToUin 返回的 Map 缺目标 uid → user_id=0 兜底", async () => {
        const groupApi = {
            // 转换表不含 u_90002 → map.get(uid) ?? 0 走兜底
            uidToUin: vi.fn(async () => new Map([["u_other", "777"]])),
        };
        const { adapter, msg, events } = makeEventAdapter({ overrides: { groupApi } });
        await adapter.subscribeOnly();
        msg.handlers.get("Msg/onRecvSysMsg")?.([
            [...cardBlob("1101729931", "u_90002", "新名片", "旧名片")],
        ]);
        await vi.waitFor(() => {
            expect(events.some((e) => e["notice_type"] === "group_card")).toBe(true);
        });
        expect(
            (events.find((e) => e["notice_type"] === "group_card") as Record<string, unknown>)[
                "user_id"
            ],
        ).toBe(0);
        adapter.unsubscribeOnly();
    });
});

/** varint 编码（合成 sysmsg 用）。 */
function encVarint(v: number): number[] {
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

/** length-delimited 字段（tag + 长度 + 字节）。 */
function bytesField(no: number, text: string): number[] {
    const payload = [...new TextEncoder().encode(text)];
    return [(no << 3) | 0x02, payload.length, ...payload];
}

/** 合成 732:21 群名片变更（只有前两个串，名片新旧缺失）。 */
function cardBlob2(group: string, uid: string): number[] {
    const f2 = [0x08, ...encVarint(732), 0x10, ...encVarint(21)];
    return [0x12, f2.length, ...f2, ...bytesField(3, group), ...bytesField(4, uid)];
}

/** 合成 732:21 群名片变更（strings = [群号, 对象 uid, 新名片, 旧名片]）。 */
function cardBlob(group: string, uid: string, cardNew: string, cardOld: string): number[] {
    const f2 = [0x08, ...encVarint(732), 0x10, ...encVarint(21)];
    return [
        0x12,
        f2.length,
        ...f2,
        ...bytesField(3, group),
        ...bytesField(4, uid),
        ...bytesField(5, cardNew),
        ...bytesField(6, cardOld),
    ];
}

describe("群请求分支（broadcastGroupRequests）", () => {
    it("已处理状态（status ≠ KUNHANDLE）→ 事件 null 跳过不广播", async () => {
        const groupHandlers = new Map<string, (...args: unknown[]) => void>();
        const groupChannel = stub<GroupEventChannel>({
            on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
                groupHandlers.set(event, handler);
                return () => undefined;
            }),
        });
        const groupApi = { uidToUin: vi.fn(async () => new Map<string, string>()) };
        const { adapter, events } = makeEventAdapter({ overrides: { groupApi }, groupChannel });
        await adapter.subscribeOnly();
        const handled = stub<GroupNotify>({ seq: "9", type: 7, status: 2 });
        groupHandlers.get("Group/onGroupNotifiesUpdated")?.(false, [handled]);
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(events).toHaveLength(0);
        adapter.unsubscribeOnly();
    });
});

describe("传输装配跳过与请求兜底（broadcaster 缺省 / 非 Error 异常）", () => {
    it("broadcaster 缺省 → start 跳过传输装配（transports=null）且 stop 走 null 分支", async () => {
        const { adapter, msg } = makeEventAdapter({
            broadcaster: null, // 显式缺省：构造参数不传广播器（BaseProtocolAdapter 允许 undefined）
        });
        await adapter.start();
        // 传输未装配（broadcaster === undefined 分支）；订阅链路照常
        const transports = (adapter as unknown as { transports: unknown | null }).transports;
        expect(transports).toBeNull();
        expect(msg.channel.on).toHaveBeenCalledTimes(4);
        await adapter.stop();
        // stop → stopAll：transports=null 分支 + 全部退订
        expect(msg.off).toHaveBeenCalledTimes(4);
    });

    it("请求包装层：非 Error 异常 → 兜底 respond message=String(err)", async () => {
        const { adapter } = makeEventAdapter({
            seed: {
                httpServers: [{ enabled: true, host: "127.0.0.1", port: 0 }],
                heartbeatInterval: 0,
            },
        });
        await adapter.start();
        try {
            const wrapped = (
                adapter as unknown as {
                    transports: {
                        servers: Array<{
                            onRequest?: (req: unknown, respond: (res: unknown) => void) => void;
                        }>;
                    } | null;
                }
            ).transports?.servers[0]?.onRequest as (
                req: unknown,
                respond: (res: unknown) => void,
            ) => void;
            expect(wrapped).toBeTypeOf("function");
            const responses: unknown[] = [];
            let calls = 0;
            wrapped({ action: "get_status" }, (res) => {
                calls += 1;
                responses.push(res);
                if (calls === 1) {
                    throw "响应失败"; // 非 Error（字符串）触发 instanceof 判定假分支
                }
            });
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(responses).toHaveLength(2);
            expect(responses[1]).toMatchObject({ retcode: 999, message: "响应失败" });
        } finally {
            await adapter.stop();
        }
    });
});

describe("传输装配与请求链（start + 真传输）", () => {
    it("start() 装配 HTTP server 并 open（含正向上报 client 的 open 循环）", async () => {
        const seed = {
            httpServers: [{ enabled: true, host: "127.0.0.1", port: 37240 }],
            httpPostUrls: [{ enabled: true, url: "http://127.0.0.1:1/nowhere" }],
            heartbeatInterval: 0,
        };
        const { adapter, events } = makeEventAdapter({ seed });
        await adapter.start();
        // lifecycle enable 已广播（传输打开成功）
        expect(events[0]).toMatchObject({ meta_event_type: "lifecycle" });
        await adapter.stop();
    });

    it("handleRequest 包装层兜底 catch：respond 首次抛错 → 999 兜底二次 respond", async () => {
        const seed = {
            httpServers: [{ enabled: true, host: "127.0.0.1", port: 37241 }],
            heartbeatInterval: 0,
        };
        const { adapter } = makeEventAdapter({ seed });
        await adapter.start();
        try {
            // 从装配的传输上取回包装后的 handleRequest（private 字段，测试窥视）
            const transports = (
                adapter as unknown as {
                    transports: {
                        servers: Array<{
                            onRequest?: (req: unknown, respond: (res: unknown) => void) => void;
                        }>;
                    } | null;
                }
            ).transports;
            const wrapped = transports?.servers[0]?.onRequest;
            expect(wrapped).toBeTypeOf("function");
            let calls = 0;
            wrapped?.({ action: "get_status" }, () => {
                calls += 1;
                if (calls === 1) {
                    throw new Error("respond 崩了");
                }
            });
            // 兜底 catch 异步二次 respond（等一拍微任务）
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(calls).toBe(2);
        } finally {
            await adapter.stop();
        }
    });
});

describe("精华链补充分支", () => {
    /** 带 group 通道的 harness（webApi/msgApi 可控）。 */
    function makeEssenceHarness(fetchBehavior: "ok" | "reject"): {
        adapter: NapukettoOneBot11Adapter;
        group: ReturnType<typeof captureChannel>;
        events: Record<string, unknown>[];
        warn: ReturnType<typeof vi.fn>;
        getEssenceList: ReturnType<typeof vi.fn>;
    } {
        const group = captureChannel();
        const events: Record<string, unknown>[] = [];
        const warn = vi.fn();
        const getEssenceList = vi.fn(async (_group: string): Promise<EssenceMsgItem[]> => []);
        const fetchMsgs =
            fetchBehavior === "reject"
                ? vi.fn(async () => {
                      throw new Error("fetchMessages 崩了");
                  })
                : vi.fn(async (_peer: Peer, _opts: unknown): Promise<RawMessage[]> => []);
        const overrides = {
            webApi: stub<WebApi>({ getEssenceMsgList: getEssenceList }),
            msgApi: stub<MsgApi>({ fetchMessages: fetchMsgs }),
        };
        const adapter = new NapukettoOneBot11Adapter({
            ...stubOptions(overrides),
            config: new ConfigBase({
                path: "ob11-test.toml",
                schema: ob11ConfigSchema,
                defaults: ob11ConfigSchema.parse({}),
                seed: ob11ConfigSchema.parse({}),
            }),
            broadcaster: stub<EventBroadcaster>({
                emit: (e: unknown) => events.push(e as Record<string, unknown>),
            }),
            msgChannel: captureChannel().channel,
            groupChannel: group.channel as unknown as GroupEventChannel,
            logger: { warn, info: vi.fn(), debug: vi.fn() },
        });
        return { adapter, group, events, warn, getEssenceList };
    }

    /** EssenceMsgItem 桩（sender 可空）。 */
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

    it("列表变更参数未知形状 → warn 校准（不入串行链）", async () => {
        const { adapter, group, warn, getEssenceList } = makeEssenceHarness("ok");
        await adapter.subscribeOnly();
        group.handlers.get("Group/onGroupEssenceListChange")?.({ bogus: 1 });
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(getEssenceList).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[1]).toContain("onGroupEssenceListChange 未知参数形状");
        adapter.unsubscribeOnly();
    });

    it("移除项 sender 不可得 → warn 跳过 delete 事件", async () => {
        const { adapter, group, events, warn, getEssenceList } = makeEssenceHarness("ok");
        await adapter.subscribeOnly();
        // 基线：含 seq 150（sender_uin 空串 → prev 缓存 sender 不可得）
        getEssenceList.mockResolvedValue([essenceItem(150, "10002", "")]);
        group.handlers.get("Group/onGroupEssenceListChange")?.(["1101729931"]);
        await vi.waitFor(() => {
            expect(getEssenceList).toHaveBeenCalledTimes(1);
        });
        // 次轮：150 被移除 → delete 广播路径 sender 为 null → warn
        getEssenceList.mockResolvedValue([]);
        group.handlers.get("Group/onGroupEssenceListChange")?.(["1101729931"]);
        await vi.waitFor(() => {
            expect(warn.mock.calls.some((c) => String(c[1]).includes("sender 不可得"))).toBe(true);
        });
        expect(events).toHaveLength(0);
        adapter.unsubscribeOnly();
    });

    it("移除项 message_id 反查未命中 → 跳过事件（delete 分支 continue）", async () => {
        const { adapter, group, events, warn, getEssenceList } = makeEssenceHarness("ok");
        await adapter.subscribeOnly();
        getEssenceList.mockResolvedValue([essenceItem(150, "10002")]);
        group.handlers.get("Group/onGroupEssenceListChange")?.(["1101729931"]);
        await vi.waitFor(() => {
            expect(getEssenceList).toHaveBeenCalledTimes(1);
        });
        // 次轮移除 150，fetchMsgs 默认返回空 → message_id 反查未命中
        getEssenceList.mockResolvedValue([]);
        group.handlers.get("Group/onGroupEssenceListChange")?.(["1101729931"]);
        await vi.waitFor(() => {
            expect(
                warn.mock.calls.some((c) => String(c[1]).includes("message_id 反查未命中")),
            ).toBe(true);
        });
        expect(events).toHaveLength(0);
        adapter.unsubscribeOnly();
    });

    it("精华 message_id 反查 fetchMessages 抛错 → 按未命中处理（warn）", async () => {
        const { adapter, group, warn, getEssenceList } = makeEssenceHarness("reject");
        await adapter.subscribeOnly();
        getEssenceList.mockResolvedValue([essenceItem(150, "10002")]);
        group.handlers.get("Group/onGroupEssenceListChange")?.(["1101729931"]);
        await vi.waitFor(() => {
            expect(getEssenceList).toHaveBeenCalledTimes(1);
        });
        getEssenceList.mockResolvedValue([essenceItem(150, "10002"), essenceItem(151, "10003")]);
        group.handlers.get("Group/onGroupEssenceListChange")?.(["1101729931"]);
        await vi.waitFor(() => {
            expect(
                warn.mock.calls.some((c) => String(c[1]).includes("message_id 反查未命中")),
            ).toBe(true);
        });
        adapter.unsubscribeOnly();
    });
});

describe("精华串行链 rejection 恢复", () => {
    it("广播抛错 → 链吞掉 rejection；紧随其后的一次同步被恢复分支消费，再下一次恢复运行", async () => {
        const group = captureChannel();
        const events: Record<string, unknown>[] = [];
        const warn = vi.fn();
        let throwOnEssence = true;
        const getEssenceList = vi.fn(async (_group: string): Promise<EssenceMsgItem[]> => []);
        const adapter = new NapukettoOneBot11Adapter({
            ...stubOptions({
                webApi: { getEssenceMsgList: getEssenceList },
                msgApi: {
                    fetchMessages: vi.fn(async () => [
                        stub<RawMessage>({ msgId: "nt-151", msgSeq: "151" }),
                    ]),
                },
            }),
            config: new ConfigBase({
                path: "ob11-test.toml",
                schema: ob11ConfigSchema,
                defaults: ob11ConfigSchema.parse({}),
                seed: ob11ConfigSchema.parse({}),
            }),
            broadcaster: stub<EventBroadcaster>({
                emit: (e: unknown) => {
                    const event = e as Record<string, unknown>;
                    if (throwOnEssence && event["notice_type"] === "group_essence") {
                        throwOnEssence = false;
                        throw new Error("emit 崩了");
                    }
                    events.push(event);
                },
                register: () => undefined,
                unregister: () => undefined,
            }),
            msgChannel: captureChannel().channel,
            groupChannel: group.channel as unknown as GroupEventChannel,
            logger: { warn, info: vi.fn(), debug: vi.fn() },
        });
        await adapter.subscribeOnly();
        const item = (seq: number) => ({
            msg_seq: seq,
            msg_random: seq,
            sender_uin: "10001",
            sender_nick: "s",
            add_digest_uin: "10002",
            add_digest_nick: "op",
            add_digest_time: 1793540100,
            msg_content: [],
        });
        // 基线
        getEssenceList.mockResolvedValue([item(150)]);
        group.handlers.get("Group/onGroupEssenceListChange")?.(["1101729931"]);
        await vi.waitFor(() => {
            expect(getEssenceList).toHaveBeenCalledTimes(1);
        });
        // 新增 → add 广播抛错（链 rejection 被吞）。then(sync, recover) 语义：
        // 失败后紧随入队的那次同步被恢复分支消费（不执行），再下一次恢复运行——
        // 三个触发同 tick 入队（恢复 handler 先于 rejection 事件挂上，
        // 避免 unhandledRejection 窗口）。
        getEssenceList.mockResolvedValue([item(150), item(151)]);
        group.handlers.get("Group/onGroupEssenceListChange")?.(["1101729931"]);
        group.handlers.get("Group/onGroupEssenceListChange")?.(["1101729931"]);
        group.handlers.get("Group/onGroupEssenceListChange")?.(["1101729931"]);
        await vi.waitFor(() => {
            // 基线 1 次 + 失败的同步 1 次 + 恢复后重新运行 1 次 = 3
            expect(getEssenceList).toHaveBeenCalledTimes(3);
        });
        // 再触发一次：链仍然活着（第四次同步照常执行，diff 空无事件）
        group.handlers.get("Group/onGroupEssenceListChange")?.(["1101729931"]);
        await vi.waitFor(() => {
            expect(getEssenceList).toHaveBeenCalledTimes(4);
        });
        expect(events).toHaveLength(0);
        adapter.unsubscribeOnly();
    });
});

describe("消息事件链（broadcastMessageEvent 分支）", () => {
    /** 群 at 消息（可带 reply）。 */
    function groupAtMsg(replyId?: string): unknown {
        return {
            msgId: "nt-at",
            msgSeq: "77",
            msgTime: "1700000000000",
            chatType: 2,
            peerUid: "808",
            senderUin: "90009",
            senderUid: "u90009",
            sendNickName: "某人",
            elements: [
                ...(replyId !== undefined
                    ? [{ elementType: 7, replyElement: { replayMsgId: replyId } }]
                    : []),
                { elementType: 1, textElement: { content: "@甲", atType: 2, atUid: "u90002" } },
            ],
        };
    }

    it("at uid 批量转换成功 → at 段 qq=uin；reply 反查 OB11 id", async () => {
        const groupApi = {
            uidToUin: vi.fn(
                async (uids: string[]) => new Map(uids.map((u) => [u, u.replace("u", "")])),
            ),
        };
        const { adapter, msg, events } = makeEventAdapter({ overrides: { groupApi } });
        await adapter.subscribeOnly();
        // 预登记被回复消息的 OB11 id（首个分配为 1，本消息为 2）
        const unique = (
            adapter as unknown as {
                oneBotApi: { messageUnique: { alloc: (id: string, peer: unknown) => number } };
            }
        ).oneBotApi.messageUnique;
        unique.alloc("nt-src", { chatType: 2, peerUid: "808" }); // id 1
        msg.handlers.get("Msg/onRecvMsg")?.([groupAtMsg("nt-src")]);
        await vi.waitFor(() => {
            expect(events).toHaveLength(1);
        });
        const segments = events[0]?.["message"] as Array<{
            type: string;
            data: Record<string, unknown>;
        }>;
        expect(segments?.find((s) => s.type === "reply")?.data["id"]).toBe("1");
        expect(segments.find((s) => s.type === "at")?.data["qq"]).toBe("90002");
        adapter.unsubscribeOnly();
    });

    it("uidToUin 抛错 → at 段保留 uid（不阻塞上报）", async () => {
        const groupApi = {
            uidToUin: vi.fn(async () => {
                throw new Error("转换服务不可用");
            }),
        };
        const { adapter, msg, events } = makeEventAdapter({ overrides: { groupApi } });
        await adapter.subscribeOnly();
        msg.handlers.get("Msg/onRecvMsg")?.([groupAtMsg()]);
        await vi.waitFor(() => {
            expect(events).toHaveLength(1);
        });
        const segments = events[0]?.["message"] as Array<{
            type: string;
            data: Record<string, unknown>;
        }>;
        expect(segments?.find((s) => s.type === "at")?.data["qq"]).toBe("u90002");
        adapter.unsubscribeOnly();
    });
});

describe("群请求链补充分支", () => {
    it("空通知数组 → uidToUinMap 短路（空 Map）且无事件", async () => {
        const groupHandlers = new Map<string, (...args: unknown[]) => void>();
        const groupChannel = stub<GroupEventChannel>({
            on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
                groupHandlers.set(event, handler);
                return () => undefined;
            }),
        });
        const groupApi = { uidToUin: vi.fn(async () => new Map<string, string>()) };
        const { adapter, events } = makeEventAdapter({
            overrides: { groupApi },
            groupChannel,
        });
        await adapter.subscribeOnly();
        groupHandlers.get("Group/onGroupNotifiesUpdated")?.(false, []);
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(groupApi.uidToUin).not.toHaveBeenCalled();
        expect(events).toHaveLength(0);
        adapter.unsubscribeOnly();
    });
});
