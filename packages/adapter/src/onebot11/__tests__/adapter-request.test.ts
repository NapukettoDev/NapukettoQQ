/**
 * adapter 请求分发与事件链补充测试：handleRequest（404/echo/缺参）、心跳
 * （fake timers）、reportSelfMessage、offline_file / online_file / 好友列表 raw 日志、
 * sysmsg 732:21 group_card 识别表广播路径（uid→uin 批量转换）。
 *
 * 与 adapter.test.ts（IPC 桥面 / reload / essence）互补，避免重复覆盖。
 */
import type {
    BuddyEventChannel,
    FriendApi,
    GroupApi,
    GroupEventChannel,
    GroupNotifyApi,
    MsgApi,
    MsgEventChannel,
    ProfileApi,
    ProfileLikeApi,
    RichMediaApi,
    TicketApi,
    WebApi,
} from "@napuketto/kernel";
import type { EventBroadcaster } from "@napuketto/network";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigBase } from "../../core/index.js";
import { stub } from "../../shared/__tests__/stub.js";
import {
    type AdapterLoggerLike,
    NapukettoOneBot11Adapter,
    type OneBot11AdapterOptions,
} from "../adapter.js";

import { ob11ConfigSchema } from "../helper/index.js";

/** 桩 kernel apis（可注入 groupApi 覆盖）。 */
function stubOptions(
    groupApi?: Record<string, unknown>,
): Omit<OneBot11AdapterOptions, "config" | "broadcaster" | "msgChannel"> {
    return stub<Omit<OneBot11AdapterOptions, "config" | "broadcaster" | "msgChannel">>({
        msgApi: stub<MsgApi>({}),
        groupApi: stub<GroupApi>(groupApi ?? {}),
        groupNotifyApi: stub<GroupNotifyApi>({}),
        friendApi: stub<FriendApi>({}),
        ticketApi: stub<TicketApi>({}),
        richMediaApi: stub<RichMediaApi>({}),
        profileApi: stub<ProfileApi>({}),
        profileLikeApi: stub<ProfileLikeApi>({}),
        webApi: stub<WebApi>({}),
        self: { uin: "10001", nickname: "测试号" },
        system: { appVersion: "test" },
    });
}

/** 捕获 handler 的假通道。 */
function captureChannel(): {
    channel: MsgEventChannel;
    handlers: Map<string, (...args: unknown[]) => void>;
} {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const channel = stub<MsgEventChannel>({
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
            handlers.set(event, handler);
            return () => handlers.delete(event);
        }),
    });
    return { channel, handlers };
}

/** 构造适配器（seed 配置；事件捕获数组返回）。 */
function makeAdapter(options?: {
    seed?: Record<string, unknown>;
    groupApi?: Record<string, unknown>;
    logger?: AdapterLoggerLike;
    groupChannel?: GroupEventChannel;
    friendChannel?: BuddyEventChannel;
}): {
    adapter: NapukettoOneBot11Adapter;
    events: Record<string, unknown>[];
    msg: ReturnType<typeof captureChannel>;
} {
    const msg = captureChannel();
    const events: Record<string, unknown>[] = [];
    const adapter = new NapukettoOneBot11Adapter({
        ...stubOptions(options?.groupApi),
        config: new ConfigBase({
            path: "ob11-test.toml",
            schema: ob11ConfigSchema,
            defaults: ob11ConfigSchema.parse({}),
            seed: ob11ConfigSchema.parse(options?.seed ?? {}),
        }),
        broadcaster: stub<EventBroadcaster>({
            emit: (e: unknown) => events.push(e as Record<string, unknown>),
        }),
        msgChannel: msg.channel,
        ...(options?.groupChannel !== undefined ? { groupChannel: options.groupChannel } : {}),
        ...(options?.friendChannel !== undefined ? { friendChannel: options.friendChannel } : {}),
        ...(options?.logger !== undefined ? { logger: options.logger } : {}),
    });
    return { adapter, events, msg };
}

describe("handleRequest（请求分发）", () => {
    it("缺 action → retcode 404「请求缺少 action」", async () => {
        const { adapter } = makeAdapter();
        const responses: unknown[] = [];
        await adapter.handleRequest({ params: {} }, (res) => responses.push(res));
        expect(responses[0]).toMatchObject({ retcode: 404, status: "failed", data: null });
        expect((responses[0] as { message: string }).message).toBe("请求缺少 action");
    });

    it("未知 action → retcode 404「未知动作」", async () => {
        const { adapter } = makeAdapter();
        const responses: unknown[] = [];
        await adapter.handleRequest({ action: "no_such_action" }, (res) => responses.push(res));
        expect((responses[0] as { retcode: number }).retcode).toBe(404);
        expect((responses[0] as { message: string }).message).toBe("未知动作: no_such_action");
    });

    it("缺 action 带 echo → 404 响应透传 echo（WS 客户端按 echo 关联请求）", async () => {
        const { adapter } = makeAdapter();
        const responses: unknown[] = [];
        await adapter.handleRequest({ params: {}, echo: "echo-missing" }, (res) =>
            responses.push(res),
        );
        expect(responses[0]).toMatchObject({
            retcode: 404,
            status: "failed",
            echo: "echo-missing",
        });
    });

    it("未知 action 带 echo → 404 响应透传 echo；无 echo 不写 echo 字段", async () => {
        const { adapter } = makeAdapter();
        const responses: unknown[] = [];
        await adapter.handleRequest({ action: "nope", echo: 42 }, (res) => responses.push(res));
        expect(responses[0]).toMatchObject({ retcode: 404, echo: 42 });
        responses.length = 0;
        await adapter.handleRequest({ action: "nope" }, (res) => responses.push(res));
        expect(responses[0]).toMatchObject({ retcode: 404 });
        expect("echo" in (responses[0] as object)).toBe(false);
    });

    it("已知动作无 echo → HTTP 入口 handle（参数校验失败 retcode 400）", async () => {
        const { adapter } = makeAdapter();
        const responses: unknown[] = [];
        // get_group_info 缺 group_id → HTTP 400
        await adapter.handleRequest({ action: "get_group_info" }, (res) => responses.push(res));
        expect((responses[0] as { retcode: number }).retcode).toBe(400);
        // 合法调用 → ok
        responses.length = 0;
        await adapter.handleRequest({ action: "get_status", params: {} }, (res) =>
            responses.push(res),
        );
        expect(responses[0]).toMatchObject({
            retcode: 0,
            status: "ok",
            data: { online: true, good: true },
        });
    });

    it("带 echo → WS 入口 websocketHandle（echo 原样带回）", async () => {
        const { adapter } = makeAdapter();
        const responses: unknown[] = [];
        await adapter.handleRequest({ action: "get_status", echo: "echo-9" }, (res) =>
            responses.push(res),
        );
        expect(responses[0]).toMatchObject({ retcode: 0, echo: "echo-9" });
    });

    it("params 缺省按 {} 处理（OB11 规范）", async () => {
        const { adapter } = makeAdapter();
        const responses: unknown[] = [];
        await adapter.handleRequest({ action: "get_robot_uin_range" }, (res) =>
            responses.push(res),
        );
        expect((responses[0] as { retcode: number }).retcode).toBe(0);
    });

    it("req 为 null/非对象 → 按 404 处理（不抛错）", async () => {
        const { adapter } = makeAdapter();
        const responses: unknown[] = [];
        await adapter.handleRequest(null, (res) => responses.push(res));
        expect((responses[0] as { retcode: number }).retcode).toBe(404);
    });
});

describe("心跳（meta_event heartbeat）", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("默认间隔（3000ms）到点广播 heartbeat；stop 后停止", async () => {
        const { adapter, events } = makeAdapter();
        await adapter.start();
        const heartbeatCount = () =>
            events.filter((e) => e["meta_event_type"] === "heartbeat").length;
        expect(heartbeatCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(3000);
        expect(heartbeatCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(6000);
        expect(heartbeatCount()).toBe(3);
        const beat = events.find((e) => e["meta_event_type"] === "heartbeat") as Record<
            string,
            unknown
        >;
        expect(beat).toMatchObject({
            post_type: "meta_event",
            self_id: 10001,
            interval: 3000,
            status: { online: true, good: true },
        });
        await adapter.stop();
        await vi.advanceTimersByTimeAsync(9000);
        expect(heartbeatCount()).toBe(3);
    });

    it("heartbeatInterval=0 → 不起心跳", async () => {
        const { adapter, events } = makeAdapter({ seed: { heartbeatInterval: 0 } });
        await adapter.start();
        await vi.advanceTimersByTimeAsync(60000);
        expect(events.filter((e) => e["meta_event_type"] === "heartbeat")).toHaveLength(0);
        await adapter.stop();
    });

    it("start 时广播 lifecycle enable（self_id 注入）", async () => {
        const { adapter, events } = makeAdapter();
        await adapter.start();
        expect(events[0]).toMatchObject({
            post_type: "meta_event",
            meta_event_type: "lifecycle",
            sub_type: "enable",
            self_id: 10001,
        });
        await adapter.stop();
    });
});

describe("reportSelfMessage（自消息上报开关）", () => {
    /** 自身消息（senderUin = 适配器 self.uin）。 */
    function selfTextMsg(): unknown {
        return {
            msgId: "nt-self",
            msgSeq: "1",
            msgTime: "1700000000000",
            chatType: 2,
            peerUid: "808",
            senderUin: "10001",
            senderUid: "u10001",
            sendNickName: "测试号",
            elements: [{ elementType: 1, textElement: { content: "自言自语" } }],
        };
    }

    it("缺省 false → 自己发的消息不上报", async () => {
        const { adapter, msg, events } = makeAdapter();
        await adapter.subscribeOnly();
        msg.handlers.get("Msg/onRecvMsg")?.([selfTextMsg()]);
        await vi.waitFor(() => {
            expect(events).toHaveLength(0);
        });
        adapter.unsubscribeOnly();
    });

    it("reportSelfMessage=true → 自消息上报为 message 事件", async () => {
        const { adapter, msg, events } = makeAdapter({ seed: { reportSelfMessage: true } });
        await adapter.subscribeOnly();
        msg.handlers.get("Msg/onRecvMsg")?.([selfTextMsg()]);
        await vi.waitFor(() => {
            expect(events).toHaveLength(1);
        });
        expect(events[0]).toMatchObject({
            post_type: "message",
            message_type: "group",
            self_id: 10001,
            user_id: 10001,
        });
        adapter.unsubscribeOnly();
    });
});

describe("c3 扩展源：offline_file / online_file / 好友列表 raw 日志", () => {
    it("onRecvOfflineFileMsg 已知形状 → offline_file notice（逐条）", async () => {
        const { adapter, msg, events } = makeAdapter();
        await adapter.subscribeOnly();
        msg.handlers.get("Msg/onRecvOfflineFileMsg")?.([
            {
                elements: [
                    {
                        elementType: 3,
                        fileElement: { fileName: "离线.zip", fileSize: "2048", fileUuid: "u1" },
                    },
                ],
                senderUin: "90009",
                peerUid: "u90009",
                msgTime: "1700000000000",
            },
        ]);
        await vi.waitFor(() => {
            expect(events).toHaveLength(1);
        });
        expect(events[0]).toMatchObject({
            post_type: "notice",
            notice_type: "offline_file",
            user_id: 90009,
        });
        adapter.unsubscribeOnly();
    });

    it("onRecvOfflineFileMsg 未知形状 → warn 校准日志（无事件）", async () => {
        const warn = vi.fn();
        const { adapter, msg, events } = makeAdapter({
            logger: { warn, info: vi.fn(), debug: vi.fn() },
        });
        await adapter.subscribeOnly();
        msg.handlers.get("Msg/onRecvOfflineFileMsg")?.("not-a-shape");
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[1]).toContain("onRecvOfflineFileMsg 未知参数形状");
        expect(events).toHaveLength(0);
        adapter.unsubscribeOnly();
    });

    it("onRecvOnlineFileMsg → debug raw 日志（OB11 无对应通知）", async () => {
        const debug = vi.fn();
        const { adapter, msg } = makeAdapter({
            logger: { warn: vi.fn(), info: vi.fn(), debug },
        });
        await adapter.subscribeOnly();
        msg.handlers.get("Msg/onRecvOnlineFileMsg")?.({ blob: true });
        expect(debug).toHaveBeenCalledTimes(1);
        expect(debug.mock.calls[0]?.[1]).toContain("onRecvOnlineFileMsg raw");
        adapter.unsubscribeOnly();
    });

    it("Buddy/onBuddyListChange(V2) → info raw 校准日志（friend_add 数据源积累）", async () => {
        const info = vi.fn();
        const friendHandlers = new Map<string, (...args: unknown[]) => void>();
        const friendChannel = stub<BuddyEventChannel>({
            on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
                friendHandlers.set(event, handler);
                return () => undefined;
            }),
        });
        const { adapter } = makeAdapter({
            logger: { warn: vi.fn(), info, debug: vi.fn() },
            friendChannel,
        });
        await adapter.subscribeOnly();
        expect(friendHandlers.has("Buddy/onBuddyListChange")).toBe(true);
        expect(friendHandlers.has("Buddy/onBuddyListChangedV2")).toBe(true);
        friendHandlers.get("Buddy/onBuddyListChange")?.([{ categoryId: 1 }]);
        expect(info).toHaveBeenCalledTimes(1);
        expect(info.mock.calls[0]?.[1]).toContain("onBuddyListChange");
        adapter.unsubscribeOnly();
    });
});

describe("sysmsg 732:21 group_card 识别表路径", () => {
    /** varint 编码。 */
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

    it("命中识别表 → group_card notice 广播（uid→uin 批量转换）", async () => {
        const groupApi = {
            uidToUin: vi.fn(async () => new Map([["u_90002", "90002"]])),
        };
        const { adapter, msg, events } = makeAdapter({ groupApi });
        await adapter.subscribeOnly();
        msg.handlers.get("Msg/onRecvSysMsg")?.([
            [...cardBlob("1101729931", "u_90002", "新名片", "旧名片")],
        ]);
        await vi.waitFor(() => {
            expect(events.some((e) => e["notice_type"] === "group_card")).toBe(true);
        });
        const event = events.find((e) => e["notice_type"] === "group_card") as Record<
            string,
            unknown
        >;
        expect(event).toMatchObject({
            post_type: "notice",
            notice_type: "group_card",
            group_id: 1101729931,
            user_id: 90002,
            card_new: "新名片",
            card_old: "旧名片",
        });
        expect(groupApi.uidToUin).toHaveBeenCalledWith(["u_90002"]);
        adapter.unsubscribeOnly();
    });

    it("subject 非 u_ 形态 → collectUids 空 + extract 失败，落校准日志不广播", async () => {
        const debug = vi.fn();
        const groupApi = { uidToUin: vi.fn(async () => new Map<string, string>()) };
        const { adapter, msg, events } = makeAdapter({
            groupApi,
            logger: { warn: vi.fn(), info: vi.fn(), debug },
        });
        await adapter.subscribeOnly();
        msg.handlers.get("Msg/onRecvSysMsg")?.([
            [...cardBlob("1101729931", "90002", "新名片", "旧名片")],
        ]);
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(events).toHaveLength(0);
        // uidToUin 未调用（collectUids 为空短路）；提取失败落 debug 校准
        expect(groupApi.uidToUin).not.toHaveBeenCalled();
        expect(debug).toHaveBeenCalledTimes(1);
        const payload = debug.mock.calls[0]?.[0] as {
            verdict?: string;
            msgType?: number;
            subType?: number;
        };
        expect(payload.msgType).toBe(732);
        expect(payload.subType).toBe(21);
        adapter.unsubscribeOnly();
    });

    it("uid→uin 转换抛错 → 事件仍广播（user_id=0 兜底）", async () => {
        const groupApi = {
            uidToUin: vi.fn(async () => {
                throw new Error("转换服务不可用");
            }),
        };
        const { adapter, msg, events } = makeAdapter({ groupApi });
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

describe("grayTip notice 广播链（broadcastNotice）", () => {
    it("群撤回 grayTip → group_recall 事件（uidToUin 批量转换路径）", async () => {
        const groupApi = {
            uidToUin: vi.fn(
                async (uids: string[]) => new Map(uids.map((u) => [u, u.replace("u", "")])),
            ),
        };
        const { adapter, msg, events } = makeAdapter({ groupApi });
        await adapter.subscribeOnly();
        msg.handlers.get("Msg/onRecvMsg")?.([
            {
                msgId: "6800",
                msgSeq: "42",
                msgTime: "1700000000000",
                chatType: 2,
                peerUid: "808",
                senderUin: "90009",
                senderUid: "u90009",
                sendNickName: "某人",
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
        expect(events.find((e) => e["notice_type"] === "group_recall")).toMatchObject({
            group_id: 808,
            user_id: 90009,
            message_id: 42,
        });
        adapter.unsubscribeOnly();
    });
});
