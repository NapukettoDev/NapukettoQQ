/**
 * Milky 消息查询域动作测试（message-query.ts，域对齐重组，自
 * p1-message.test.ts / p3-message.test.ts 查询用例归并）
 *
 * 锁定：get_history_messages 的 seq 锚点（索引命中 / 近段扫描兜底 / NOT_FOUND）、
 * 原生新→旧反转成升序、limit 分页 next_message_seq、群实体回填、
 * get_forwarded_messages 转发索引定位与 mention uid→uin、嵌套转发段注入、
 * get_message 索引命中 + 群实体回填 / 两级 NOT_FOUND。
 */
import {
    ChatType,
    type FriendApi,
    type GroupApi,
    type GroupCache,
    type MsgApi,
    type ProfileApi,
    type RawMessage,
} from "@napuketto/kernel";
import { describe, expect, it, vi } from "vitest";
import { stub } from "../../../shared/__tests__/stub.js";
import { MilkyApi } from "../../api.js";
import { MessageSeqIndex } from "../../helper/state/seq-index.js";
import type { GetForwardedMessagesOutput, GetHistoryMessagesOutput } from "../../types.js";
import { createMilkyActionRegistry } from "../index.js";
import { buildMilkyApi, indexableMsg, messageApi, registryOf } from "./test-support.js";

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
        stub<ConstructorParameters<typeof MilkyApi>[0]>({
            msgApi: stub<MsgApi>({
                fetchMessages,
                fetchForwardMessage,
                fetchMsgsByMsgId: vi.fn(async () => []),
                markRead,
            }),
            groupApi: stub<GroupApi>({
                uinToUid: vi.fn(
                    async (uins: string[]) => new Map(uins.map((u) => [u, `uid-${u}`])),
                ),
                uidToUin: vi.fn(
                    async (uids: string[]) => new Map(uids.map((u) => [u, u.replace("uid-", "")])),
                ),
            }),
            friendApi: stub<FriendApi>({}),
            profileApi: stub<ProfileApi>({}),
            self: { uin: "10000", nickname: "机器人", uid: "uid-10000" },
            ...(stubs.groupCache !== undefined
                ? { groupCache: stub<GroupCache>(stubs.groupCache) }
                : {}),
        }),
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

    it("缺 message_scene → -400（schema 补测）", async () => {
        const { registry } = makeApi({});
        const result = await registry
            .get("get_history_messages")
            ?.handle({ peer_id: 10001, limit: 20 });
        expect(result?.retcode).toBe(-400);
    });

    it("群场景 + groupCache → 实体注入（详情 + 成员表，p3 补测）", async () => {
        const msg2 = indexableMsg("200", "m-h2");
        const msg1 = indexableMsg("199", "m-h1");
        const fetchMessages = vi.fn(async () => [msg2, msg1]); // 原生新→旧
        const api = buildMilkyApi({
            msgApi: { fetchMessages },
            groupCache: {
                getGroupDetail: vi.fn(async () => ({
                    groupCode: "10001",
                    groupName: "历史群",
                    memberNum: 2,
                    maxMemberNum: 10,
                })),
                getMembers: vi.fn(async () => [
                    { uid: "uid-20002", uin: "20002", nick: "甲", cardName: "名片甲", role: 2 },
                ]),
            },
        });
        api.seqIndex.record(indexableMsg("199", "m-h1") as never);
        const registry = registryOf(api);
        const res = await action(registry, "get_history_messages").handle({
            message_scene: "group",
            peer_id: 10001,
            start_message_seq: 199,
            limit: 2,
        });
        const data = res.data as {
            messages: Array<{ group?: { group_name: string }; group_member?: { card: string } }>;
            next_message_seq: number | null;
        };
        expect(data.messages).toHaveLength(2);
        expect(data.messages[0]?.group?.group_name).toBe("历史群");
        expect(data.messages[0]?.group_member?.card).toBe("名片甲");
        expect(data.next_message_seq).toBe(199);
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

    it("10 位秒级 msgTime（Linux 3.2.x）→ time 同值（归一不二次除 1000）", async () => {
        const { api, registry } = makeApi({
            forwarded: [rawMsg({ msgTime: "1760000000" })],
        });
        api.seqIndex.recordForward("res-1", {
            chatType: ChatType.GROUP,
            peerUid: "10001",
            msgId: "m-1",
        });
        const res = await action(registry, "get_forwarded_messages").handle({
            forward_id: "res-1",
        });
        expect((res.data as GetForwardedMessagesOutput).messages[0]?.time).toBe(1760000000);
    });

    it("forward_id 未登记：NOT_FOUND（-404）", async () => {
        const { registry } = makeApi({});
        const res = await action(registry, "get_forwarded_messages").handle({
            forward_id: "res-x",
        });
        expect(res).toMatchObject({ status: "failed", retcode: -404, data: null });
    });

    it("groupCache 成员名片优先 sender_name，缺省退 uin（p3 补测）", async () => {
        const fw1 = indexableMsg("301", "m-fw1");
        const fw2 = { ...indexableMsg("302", "m-fw2"), senderUid: "uid-other" };
        const api = buildMilkyApi({
            msgApi: {
                fetchForwardMessage: vi.fn(async () => [fw1, fw2]),
            },
            groupCache: {
                getMember: vi.fn(async (_peer: string, uid: string) =>
                    uid === "uid-20002"
                        ? { uid, uin: "20002", nick: "甲", cardName: "名片甲", role: 2 }
                        : undefined,
                ),
            },
        });
        api.seqIndex.recordForward("res-id9", {
            chatType: ChatType.GROUP,
            peerUid: "10001",
            msgId: "m-fw1",
        });
        const registry = registryOf(api);
        const res = await action(registry, "get_forwarded_messages").handle({
            forward_id: "res-id9",
        });
        const data = res.data as {
            messages: Array<{ sender_name: string; avatar_url: string; time: number }>;
        };
        expect(data.messages[0]?.sender_name).toBe("名片甲");
        expect(data.messages[1]?.sender_name).toBe("20002"); // 成员缺失退 uin
        expect(data.messages[0]?.avatar_url).toContain("nk=20002");
    });
});

describe("get_message", () => {
    it("索引命中 + group 场景实体回填（groupCache）", async () => {
        const detail = {
            groupCode: "10001",
            groupName: "实体群",
            memberNum: 5,
            maxMemberNum: 100,
        };
        const member = {
            uid: "uid-20002",
            uin: "20002",
            nick: "甲",
            cardName: "名片甲",
            role: 3,
        };
        const api = buildMilkyApi({
            msgApi: { fetchMsgsByMsgId: vi.fn(async () => [indexableMsg("150")]) },
            groupCache: {
                getGroupDetail: vi.fn(async () => detail),
                getMember: vi.fn(async () => member),
            },
        });
        api.seqIndex.record(indexableMsg("150") as never);
        const registry = registryOf(api);
        const res = await action(registry, "get_message").handle({
            message_scene: "group",
            peer_id: 10001,
            message_seq: 150,
        });
        const data = res.data as {
            message: {
                message_scene: string;
                group: { group_name: string };
                group_member: { card: string };
                segments: Array<{ type: string; data: { text: string } }>;
            };
        };
        expect(data.message.message_scene).toBe("group");
        expect(data.message.group.group_name).toBe("实体群");
        expect(data.message.group_member.card).toBe("名片甲");
        expect(data.message.segments[0]).toEqual({ type: "text", data: { text: "hi" } });
    });

    it("get_message：10 位秒级 msgTime（Linux 3.2.x）→ time 同值（归一不二次除 1000）", async () => {
        const api = buildMilkyApi({
            msgApi: {
                fetchMsgsByMsgId: vi.fn(async () => [
                    { ...indexableMsg("150"), msgTime: "1760000000" },
                ]),
            },
        });
        api.seqIndex.record({ ...indexableMsg("150"), msgTime: "1760000000" } as never);
        const registry = registryOf(api);
        const res = await action(registry, "get_message").handle({
            message_scene: "group",
            peer_id: 10001,
            message_seq: 150,
        });
        expect((res.data as { message: { time: number } }).message.time).toBe(1760000000);
    });

    it("seq 不可解析 → NOT_FOUND", async () => {
        const registry = messageApi({});
        const res = await action(registry, "get_message").handle({
            message_scene: "group",
            peer_id: 10001,
            message_seq: 1,
        });
        expect(res.retcode).toBe(-404);
    });

    it("msgId 回查为空 → NOT_FOUND", async () => {
        const api = buildMilkyApi({ msgApi: { fetchMsgsByMsgId: vi.fn(async () => []) } });
        api.seqIndex.record(indexableMsg("150") as never);
        const registry = registryOf(api);
        const res = await action(registry, "get_message").handle({
            message_scene: "group",
            peer_id: 10001,
            message_seq: 150,
        });
        expect(res.retcode).toBe(-404);
    });

    it("friend 场景：不回填群实体（friend 最小实体）", async () => {
        const api = buildMilkyApi({
            msgApi: {
                fetchMsgsByMsgId: vi.fn(async () => [
                    { ...indexableMsg("3"), chatType: ChatType.C2C, peerUid: "uid-20002" },
                ]),
            },
        });
        api.seqIndex.record({
            ...indexableMsg("3"),
            chatType: ChatType.C2C,
            peerUid: "uid-20002",
        } as never);
        const registry = registryOf(api);
        const res = await action(registry, "get_message").handle({
            message_scene: "friend",
            peer_id: 20002,
            message_seq: 3,
        });
        const data = res.data as {
            message: { message_scene: string; friend: { nickname: string } };
        };
        expect(data.message.message_scene).toBe("friend");
        expect(data.message.friend.nickname).toBe("测试群");
    });
});
