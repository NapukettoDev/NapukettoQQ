/**
 * Milky 消息类动作测试补遗（message.ts，p3 系列；P0 发送链/forward 组装链
 * 已由 message.test.ts / p2-forward-send.test.ts 覆盖）
 *
 * 锁定：recall_* 的 seq 反查（命中撤回 / 未命中 NOT_FOUND）、get_message
 * （索引命中 + 群实体回填 / 两级 NOT_FOUND）、mark_message_as_read、
 * get_custom_face_url_list、get_resource_temp_url 链接形态判定、
 * upload_private_file（fileUuid / msgId 兜底）、文件:// 媒体段路径展开、
 * 远程媒体缺 mediaDir 报错、forward messages 项非对象、段数上限。
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ChatType } from "@napuketto/kernel";
import { describe, expect, it, vi } from "vitest";
import type { OutgoingSegment } from "../../types.js";
import { type ApiOverrides, actionOf, buildMilkyApi, registryOf } from "./test-support.js";

/** 消息类依赖桩。 */
function messageApi(overrides: ApiOverrides = {}): ReturnType<typeof registryOf> {
    return registryOf(
        buildMilkyApi({
            msgApi: {
                sendMessage: vi.fn(async () => ({ msgId: "sent-1" })),
                fetchMsgsByMsgId: vi.fn(async () => []),
                fetchMessages: vi.fn(async () => []),
                recallMessage: vi.fn(async () => undefined),
                markRead: vi.fn(async () => undefined),
                queryFavEmojis: vi.fn(async () => ["https://face.example/1.png"]),
                ...overrides.msgApi,
            },
            ...overrides,
        }),
    );
}

/** 可索引的原始消息（群聊文本；msgSeq 可覆写）。 */
function indexableMsg(seq: string, msgId = "m-idx") {
    return {
        msgId,
        msgSeq: seq,
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
    };
}

describe("recall_private_message / recall_group_message", () => {
    it("群撤回：seq 索引命中 → recallMessage(peer, [msgId])", async () => {
        const recallMessage = vi.fn(async () => undefined);
        const api = buildMilkyApi({ msgApi: { recallMessage } });
        api.seqIndex.record(indexableMsg("150") as never);
        const registry = registryOf(api);
        const res = await actionOf(registry, "recall_group_message").handle({
            group_id: 10001,
            message_seq: 150,
        });
        expect(res.status).toBe("ok");
        expect(recallMessage).toHaveBeenCalledWith({ chatType: ChatType.GROUP, peerUid: "10001" }, [
            "m-idx",
        ]);
    });

    it("私聊撤回：C2C peer 解析（uin→uid）后撤回", async () => {
        const recallMessage = vi.fn(async () => undefined);
        const api = buildMilkyApi({ msgApi: { recallMessage } });
        api.seqIndex.record({
            ...indexableMsg("7"),
            chatType: ChatType.C2C,
            peerUid: "uid-20002",
        } as never);
        const registry = registryOf(api);
        const res = await actionOf(registry, "recall_private_message").handle({
            user_id: 20002,
            message_seq: 7,
        });
        expect(res.status).toBe("ok");
        expect(recallMessage).toHaveBeenCalledWith(
            { chatType: ChatType.C2C, peerUid: "uid-20002" },
            ["m-idx"],
        );
    });

    it("seq 反查未命中 → NOT_FOUND（-404）", async () => {
        const registry = messageApi({});
        const res = await actionOf(registry, "recall_group_message").handle({
            group_id: 10001,
            message_seq: 424242,
        });
        expect(res.retcode).toBe(-404);
        expect(res.message).toContain("消息 424242 不存在");
    });

    it("负 message_seq → -400", async () => {
        const registry = messageApi({});
        const res = await actionOf(registry, "recall_group_message").handle({
            group_id: 10001,
            message_seq: -1,
        });
        expect(res.retcode).toBe(-400);
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
        const res = await actionOf(registry, "get_message").handle({
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

    it("seq 不可解析 → NOT_FOUND", async () => {
        const registry = messageApi({});
        const res = await actionOf(registry, "get_message").handle({
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
        const res = await actionOf(registry, "get_message").handle({
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
        const res = await actionOf(registry, "get_message").handle({
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

describe("mark_message_as_read / get_custom_face_url_list", () => {
    it("mark_message_as_read：peer 解析后 markRead（seq 仅 schema 兼容）", async () => {
        const markRead = vi.fn(async () => undefined);
        const registry = messageApi({ msgApi: { markRead } });
        const res = await actionOf(registry, "mark_message_as_read").handle({
            message_scene: "temp",
            peer_id: 20002,
            message_seq: 1,
        });
        expect(res.status).toBe("ok");
        expect(markRead).toHaveBeenCalledWith({
            chatType: ChatType.C2C_TEMP,
            peerUid: "uid-20002",
        });
    });

    it("get_custom_face_url_list：urls 透传", async () => {
        const registry = messageApi({});
        const res = await actionOf(registry, "get_custom_face_url_list").handle({});
        expect(res.data).toEqual({ urls: ["https://face.example/1.png"] });
    });

    it("mark_message_as_read：scene 缺失 → -400", async () => {
        const registry = messageApi({});
        const res = await actionOf(registry, "mark_message_as_read").handle({
            peer_id: 10001,
            message_seq: 1,
        });
        expect(res.retcode).toBe(-400);
    });
});

describe("get_resource_temp_url", () => {
    it("http(s)/base64 形态原样返回", async () => {
        const registry = messageApi({});
        for (const id of ["http://a.example/x", "https://a.example/x.png", "base64://aGVsbG8="]) {
            const res = await actionOf(registry, "get_resource_temp_url").handle({
                resource_id: id,
            });
            expect(res.data, id).toEqual({ url: id });
        }
    });

    it("非链接形态 → NOT_FOUND（-404）", async () => {
        const registry = messageApi({});
        const res = await actionOf(registry, "get_resource_temp_url").handle({
            resource_id: "/local/path.png",
        });
        expect(res.retcode).toBe(-404);
        expect(res.message).toContain("resource_id 非链接形态");
    });

    it("空 resource_id → -400", async () => {
        const registry = messageApi({});
        const res = await actionOf(registry, "get_resource_temp_url").handle({ resource_id: "" });
        expect(res.retcode).toBe(-400);
    });
});

describe("send_private_message / send_group_message（动作层）", () => {
    it("file:// 媒体段：同步展开为平台路径（不触下载）", async () => {
        const sendMessage = vi.fn(async () => ({ msgId: "sent-1" }));
        const fetchMsgsByMsgId = vi.fn(async () => [indexableMsg("1300")]);
        const registry = messageApi({ msgApi: { sendMessage, fetchMsgsByMsgId } });
        const segments: OutgoingSegment[] = [
            { type: "text", data: { text: "看图" } },
            { type: "image", data: { uri: pathToFileURL(join("tmp", "x.png")).href } },
        ];
        const res = await actionOf(registry, "send_group_message").handle({
            group_id: 10001,
            message: segments,
        });
        expect(res.status).toBe("ok");
        const [peer, elements] = sendMessage.mock.calls[0] as unknown as [
            unknown,
            Array<{ type: string; path?: string }>,
        ];
        expect(peer).toEqual({ chatType: ChatType.GROUP, peerUid: "10001" });
        expect(elements[1]?.path?.endsWith("x.png")).toBe(true);
    });

    it("远程媒体缺 mediaDir → INVALID_PARAM（-400）", async () => {
        const registry = messageApi({});
        const res = await actionOf(registry, "send_group_message").handle({
            group_id: 10001,
            message: [{ type: "image", data: { uri: "https://img.example/a.png" } }],
        });
        expect(res.retcode).toBe(-400);
        expect(res.message).toContain("cacheDir");
    });

    it("at 转换失败（uinToUid 抛错）→ at 目标保持 uin 原样", async () => {
        const sendMessage = vi.fn(async () => ({ msgId: "sent-1" }));
        const registry = messageApi({
            msgApi: { sendMessage, fetchMsgsByMsgId: vi.fn(async () => [indexableMsg("1")]) },
            groupApi: { uinToUid: vi.fn(async () => new Map()) },
        });
        const res = await actionOf(registry, "send_group_message").handle({
            group_id: 10001,
            message: [
                { type: "mention", data: { user_id: 90001 } },
                { type: "text", data: { text: "x" } },
            ],
        });
        expect(res.status).toBe("ok");
        const elements = (
            sendMessage.mock.calls[0] as unknown as [
                unknown,
                Array<{ type: string; target?: string }>,
            ]
        )[1];
        expect(elements[0]).toEqual({ type: "at", target: "90001" });
    });

    it("段数组为空 → -400（schema min(1)）", async () => {
        const registry = messageApi({});
        const res = await actionOf(registry, "send_group_message").handle({
            group_id: 10001,
            message: [],
        });
        expect(res.retcode).toBe(-400);
    });

    it("段数超上限（201）→ -400", async () => {
        const registry = messageApi({});
        const res = await actionOf(registry, "send_group_message").handle({
            group_id: 10001,
            message: Array.from({ length: 201 }, () => ({ type: "text", data: { text: "x" } })),
        });
        expect(res.retcode).toBe(-400);
    });

    it("user_id 低于 10001 → -400", async () => {
        const registry = messageApi({});
        const res = await actionOf(registry, "send_private_message").handle({
            user_id: 100,
            message: [{ type: "text", data: { text: "x" } }],
        });
        expect(res.retcode).toBe(-400);
    });

    it("send_private_message：C2C peer（uin→uid）+ 输出回查", async () => {
        const sendMessage = vi.fn(async () => ({ msgId: "sent-1" }));
        const fetchMsgsByMsgId = vi.fn(async () => [
            {
                msgId: "sent-1",
                msgSeq: "77",
                msgTime: "1760000000000",
                chatType: ChatType.C2C,
                peerUid: "uid-20002",
                senderUin: "10000",
                senderUid: "uid-10000",
                elements: [],
            },
        ]);
        const registry = messageApi({ msgApi: { sendMessage, fetchMsgsByMsgId } });
        const res = await actionOf(registry, "send_private_message").handle({
            user_id: 20002,
            message: [{ type: "text", data: { text: "私聊" } }],
        });
        expect(res.status).toBe("ok");
        expect((sendMessage.mock.calls[0] as unknown as [unknown])?.[0]).toEqual({
            chatType: ChatType.C2C,
            peerUid: "uid-20002",
        });
        expect(res.data).toEqual({ message_seq: 77, time: 1760000000 });
    });

    it("at uinToUid 抛错 → 目标保持 uin 原样（catch → undefined 映射）", async () => {
        const sendMessage = vi.fn(async () => ({ msgId: "sent-1" }));
        const registry = messageApi({
            msgApi: { sendMessage, fetchMsgsByMsgId: vi.fn(async () => [indexableMsg("2")]) },
            groupApi: {
                uinToUid: vi.fn(async () => {
                    throw new Error("kernel down");
                }),
            },
        });
        const res = await actionOf(registry, "send_group_message").handle({
            group_id: 10001,
            message: [
                { type: "mention", data: { user_id: 90001 } },
                { type: "text", data: { text: "x" } },
            ],
        });
        expect(res.status).toBe("ok");
        const elements = (
            sendMessage.mock.calls[0] as unknown as [
                unknown,
                Array<{ type: string; target?: string }>,
            ]
        )[1];
        expect(elements[0]).toEqual({ type: "at", target: "90001" });
    });

    it("get_history_messages：群场景 + groupCache → 实体注入（详情 + 成员表）", async () => {
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
        const res = await actionOf(registry, "get_history_messages").handle({
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

    it("get_forwarded_messages：groupCache 成员名片优先 sender_name，缺省退 uin", async () => {
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
        const res = await actionOf(registry, "get_forwarded_messages").handle({
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

describe("upload_private_file（sendFileMessage 链）", () => {
    it("fileElement.fileUuid 有值 → file_id = fileUuid", async () => {
        const sent = {
            ...indexableMsg("1", "m-file"),
            elements: [{ elementType: 10, fileElement: { fileUuid: "uuid-abc" } }],
        };
        const registry = messageApi({
            msgApi: {
                sendMessage: vi.fn(async () => ({ msgId: "m-file" })),
                fetchMsgsByMsgId: vi.fn(async () => [sent]),
            },
        });
        const res = await actionOf(registry, "upload_private_file").handle({
            user_id: 20002,
            file_uri: join("tmp", "a.bin"),
            file_name: "a.bin",
        });
        expect(res.data).toEqual({ file_id: "uuid-abc" });
    });

    it("回查无 fileElement → file_id 兜底 msgId", async () => {
        const registry = messageApi({
            msgApi: {
                sendMessage: vi.fn(async () => ({ msgId: "m-fallback" })),
                fetchMsgsByMsgId: vi.fn(async () => []),
            },
        });
        const res = await actionOf(registry, "upload_private_file").handle({
            user_id: 20002,
            file_uri: "b.bin",
            file_name: "b.bin",
        });
        expect(res.data).toEqual({ file_id: "m-fallback" });
    });

    it("fileUuid 空串 → 兜底 msgId", async () => {
        const sent = {
            ...indexableMsg("1", "m-empty"),
            elements: [{ elementType: 10, fileElement: { fileUuid: "" } }],
        };
        const registry = messageApi({
            msgApi: {
                sendMessage: vi.fn(async () => ({ msgId: "m-empty" })),
                fetchMsgsByMsgId: vi.fn(async () => [sent]),
            },
        });
        const res = await actionOf(registry, "upload_private_file").handle({
            user_id: 20002,
            file_uri: "c.bin",
            file_name: "c.bin",
        });
        expect(res.data).toEqual({ file_id: "m-empty" });
    });

    it("file_uri 空串 → -400", async () => {
        const registry = messageApi({});
        const res = await actionOf(registry, "upload_private_file").handle({
            user_id: 20002,
            file_uri: "",
            file_name: "x",
        });
        expect(res.retcode).toBe(-400);
    });
});

describe("forward messages 项防御（补 p2-forward-send 未覆盖分支）", () => {
    it("messages 项为非对象（字符串）→ INVALID_PARAM", async () => {
        const registry = messageApi({});
        const res = await actionOf(registry, "send_group_message").handle({
            group_id: 10001,
            message: [
                {
                    type: "forward",
                    data: { messages: ["not-an-object"] },
                },
            ],
        });
        expect(res.retcode).toBe(-400);
        expect(res.message).toContain("messages 项必须是对象");
    });
});
