/**
 * Milky P1 消息动作测试：get_history_messages / get_forwarded_messages /
 * mark_message_as_read
 *
 * 锁定：seq 锚点（索引命中 / 近段扫描兜底 / NOT_FOUND）、原生新→旧反转成升序、
 * limit 分页的 next_message_seq、群实体回填、转发索引定位与 mention uid→uin、
 * 嵌套转发段注入。
 */
import { ChatType, type GroupCache, type RawMessage } from "@napuketto/kernel";
import { describe, expect, it, vi } from "vitest";
import { MilkyApi } from "../api.js";
import { MessageSeqIndex } from "../helper/seq-index.js";
import type { GetForwardedMessagesOutput, GetHistoryMessagesOutput } from "../types.js";
import { createMilkyActionRegistry } from "./index.js";

/** 原始消息桩（默认群聊文本消息）。 */
function rawMsg(overrides: Partial<RawMessage> = {}): RawMessage {
    return {
        msgId: "m-1",
        msgSeq: "101",
        msgTime: "1760000000000",
        msgType: 0,
        chatType: ChatType.GROUP,
        peerUid: "10001",
        peerUin: "10001",
        senderUid: "uid-20002",
        senderUin: "20002",
        peerName: "测试群",
        sendNickName: "甲",
        elements: [{ elementType: 1, textElement: { content: "hi" } }],
        ...overrides,
    };
}

/** 构造 MilkyApi（msgApi 桩 + 可选 groupCache）。 */
function makeApi(stubs: {
    history?: RawMessage[];
    forwarded?: RawMessage[];
    groupCache?: Record<string, unknown>;
}): {
    api: MilkyApi;
    fetchMessages: ReturnType<typeof vi.fn>;
    fetchForwardMessage: ReturnType<typeof vi.fn>;
    markRead: ReturnType<typeof vi.fn>;
    registry: ReturnType<typeof createMilkyActionRegistry>;
} {
    const fetchMessages = vi.fn(async () => stubs.history ?? []);
    const fetchForwardMessage = vi.fn(async () => stubs.forwarded ?? []);
    const markRead = vi.fn(async () => undefined);
    const api = new MilkyApi(
        {
            msgApi: {
                fetchMessages,
                fetchForwardMessage,
                fetchMsgsByMsgId: vi.fn(async () => []),
                markRead,
            },
            groupApi: {
                uinToUid: vi.fn(
                    async (uins: string[]) => new Map(uins.map((u) => [u, `uid-${u}`])),
                ),
                uidToUin: vi.fn(
                    async (uids: string[]) => new Map(uids.map((u) => [u, u.replace("uid-", "")])),
                ),
            },
            friendApi: {},
            profileApi: {},
            self: { uin: "10000", nickname: "机器人", uid: "uid-10000" },
            ...(stubs.groupCache !== undefined
                ? { groupCache: stubs.groupCache as unknown as GroupCache }
                : {}),
        } as unknown as ConstructorParameters<typeof MilkyApi>[0],
        new MessageSeqIndex(),
    );
    return {
        api,
        fetchMessages,
        fetchForwardMessage,
        markRead,
        registry: createMilkyActionRegistry({ api }),
    };
}

/** 取动作（未注册 = 测试桩错误，直接抛错）。 */
function action(registry: ReturnType<typeof createMilkyActionRegistry>, name: string) {
    const found = registry.get(name);
    if (found === undefined) {
        throw new Error(`动作未注册: ${name}`);
    }
    return found;
}

describe("get_history_messages", () => {
    it("群聊：原生新→旧反转成升序，登记 seq 索引，limit 命中给 next_message_seq", async () => {
        const { api, fetchMessages, registry } = makeApi({
            history: [
                rawMsg({ msgId: "m-102", msgSeq: "102" }),
                rawMsg({ msgId: "m-101", msgSeq: "101" }),
            ],
        });
        const res = await action(registry, "get_history_messages").handle({
            message_scene: "group",
            peer_id: 10001,
            limit: 2,
        });
        expect(res.status).toBe("ok");
        const data = res.data as GetHistoryMessagesOutput;
        expect(fetchMessages).toHaveBeenCalledWith(
            { chatType: ChatType.GROUP, peerUid: "10001" },
            { count: 2 },
        );
        expect(data.messages.map((m) => m.message_seq)).toEqual([101, 102]);
        expect(data.next_message_seq).toBe(101);
        // 接收链路登记：消息结束后可反查 msgId
        expect(api.seqIndex.resolveMsgId(ChatType.GROUP, "10001", 102)).toBe("m-102");
    });

    it("未取满 limit：next_message_seq 为 null", async () => {
        const { registry } = makeApi({ history: [rawMsg({ msgId: "m-101", msgSeq: "101" })] });
        const res = await action(registry, "get_history_messages").handle({
            message_scene: "group",
            peer_id: 10001,
            limit: 20,
        });
        expect((res.data as GetHistoryMessagesOutput).next_message_seq).toBeNull();
    });

    it("start_message_seq 索引命中：以 msgId 作锚点翻页（好友场景 uin→uid）", async () => {
        const { api, fetchMessages, registry } = makeApi({
            history: [rawMsg({ msgId: "m-102", msgSeq: "102", chatType: ChatType.C2C })],
        });
        api.seqIndex.record(
            rawMsg({
                msgId: "m-101",
                msgSeq: "101",
                chatType: ChatType.C2C,
                peerUid: "uid-20002",
            }),
        );
        const res = await action(registry, "get_history_messages").handle({
            message_scene: "friend",
            peer_id: 20002,
            start_message_seq: 101,
            limit: 1,
        });
        expect(res.status).toBe("ok");
        expect(fetchMessages).toHaveBeenCalledWith(
            { chatType: ChatType.C2C, peerUid: "uid-20002" },
            { count: 1, msgId: "m-101" },
        );
    });

    it("start_message_seq 未登记：近段扫描兜底命中", async () => {
        const { fetchMessages, registry } = makeApi({
            history: [
                rawMsg({ msgId: "m-105", msgSeq: "105" }),
                rawMsg({ msgId: "m-104", msgSeq: "104" }),
            ],
        });
        const res = await action(registry, "get_history_messages").handle({
            message_scene: "group",
            peer_id: 10001,
            start_message_seq: 104,
        });
        expect(res.status).toBe("ok");
        expect(fetchMessages).toHaveBeenNthCalledWith(
            1,
            { chatType: ChatType.GROUP, peerUid: "10001" },
            { count: 60 },
        );
    });

    it("start_message_seq 不存在：NOT_FOUND（-404）", async () => {
        const { registry } = makeApi({ history: [] });
        const res = await action(registry, "get_history_messages").handle({
            message_scene: "group",
            peer_id: 10001,
            start_message_seq: 999,
        });
        expect(res).toMatchObject({ status: "failed", retcode: -404, data: null });
    });

    it("群场景回填群详情 + 成员实体（缓存命中）", async () => {
        const groupCache = {
            getGroupDetail: vi.fn(async () => ({ groupCode: "10001", groupName: "测试群" })),
            getMembers: vi.fn(async () => [
                { uid: "uid-20002", uin: "20002", nick: "昵称", cardName: "名片" },
            ]),
        };
        const { registry } = makeApi({ history: [rawMsg()], groupCache });
        const res = await action(registry, "get_history_messages").handle({
            message_scene: "group",
            peer_id: 10001,
        });
        const [message] = (res.data as GetHistoryMessagesOutput).messages;
        expect(message).toMatchObject({
            group: { group_id: 10001, group_name: "测试群" },
            group_member: { user_id: 20002, nickname: "昵称", card: "名片" },
        });
    });
});

describe("get_forwarded_messages", () => {
    it("转发索引定位 peer → 内容段翻译（mention uid→uin、嵌套转发段、发送者名/头像）", async () => {
        const { api, fetchForwardMessage, registry } = makeApi({
            forwarded: [
                rawMsg({
                    msgId: "f-1",
                    msgSeq: "111",
                    elements: [
                        { elementType: 1, textElement: { content: "你好 " } },
                        {
                            elementType: 1,
                            textElement: { content: "@甲", atType: 2, atUid: "uid-90001" },
                        },
                    ],
                }),
                rawMsg({
                    msgId: "f-2",
                    msgSeq: "112",
                    elements: [
                        {
                            elementType: 1,
                            textElement: { content: "记录" },
                            multiForwardMsgElement: {
                                resId: "res-2",
                                fileName: "聊天记录",
                                xmlContent: "",
                            },
                        },
                    ],
                }),
            ],
        });
        api.seqIndex.recordForward("res-1", {
            chatType: ChatType.GROUP,
            peerUid: "10001",
            msgId: "m-1",
        });
        const res = await action(registry, "get_forwarded_messages").handle({
            forward_id: "res-1",
        });
        expect(res.status).toBe("ok");
        expect(fetchForwardMessage).toHaveBeenCalledWith(
            { chatType: ChatType.GROUP, peerUid: "10001" },
            "m-1",
        );
        const data = res.data as GetForwardedMessagesOutput;
        expect(data.messages.map((m) => m.message_seq)).toEqual([111, 112]);
        expect(data.messages[0]?.segments).toContainEqual({
            type: "mention",
            data: { user_id: 90001, name: "甲" },
        });
        expect(data.messages[1]?.segments).toContainEqual({
            type: "forward",
            data: { forward_id: "res-2", title: "聊天记录", preview: [], summary: "" },
        });
        expect(data.messages[0]?.sender_name).toBe("20002");
        expect(data.messages[0]?.avatar_url).toContain("nk=20002");
    });

    it("群成员缓存命中：发送者名取名片（退回昵称）", async () => {
        const groupCache = {
            getMember: vi.fn(async () => ({ uid: "uid-20002", nick: "昵称", cardName: "" })),
        };
        const { api, registry } = makeApi({ forwarded: [rawMsg()], groupCache });
        api.seqIndex.recordForward("res-1", {
            chatType: ChatType.GROUP,
            peerUid: "10001",
            msgId: "m-1",
        });
        const res = await action(registry, "get_forwarded_messages").handle({
            forward_id: "res-1",
        });
        expect((res.data as GetForwardedMessagesOutput).messages[0]?.sender_name).toBe("昵称");
    });

    it("forward_id 未登记：NOT_FOUND（-404）", async () => {
        const { registry } = makeApi({});
        const res = await action(registry, "get_forwarded_messages").handle({
            forward_id: "res-x",
        });
        expect(res).toMatchObject({ status: "failed", retcode: -404, data: null });
    });
});

describe("mark_message_as_read", () => {
    it("按会话标记已读（seq 仅兼容 schema）", async () => {
        const { markRead, registry } = makeApi({});
        const res = await action(registry, "mark_message_as_read").handle({
            message_scene: "group",
            peer_id: 10001,
            message_seq: 101,
        });
        expect(res).toMatchObject({ status: "ok", data: {} });
        expect(markRead).toHaveBeenCalledWith({ chatType: ChatType.GROUP, peerUid: "10001" });
    });
});
