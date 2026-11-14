/**
 * Milky 消息发送域动作测试（message-send.ts，2026-11-14 域对齐重组，自
 * message.test.ts / p2-forward-send.test.ts / p3-message.test.ts 发送用例归并）
 *
 * 锁定：sendMilkyMessage（OutgoingSegment → canonical：mention uin→uid、
 * at all、reply seq 原样兜底、未知段跳过）、响应输出 {message_seq, time}、
 * forward 组装链临时消息法调用序列、载荷收窄（空 messages / segments 空 /
 * 嵌套 forward / 混发均 -400）、撤回失败 best-effort、file:// 媒体段展开、
 * 段数上限、附加字段容忍。
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
    type CanonicalElement,
    ChatType,
    type FriendApi,
    type GroupApi,
    type GroupNotifyApi,
    type MsgApi,
    type Peer,
    type ProfileApi,
    type ProfileLikeApi,
    type RawMessage,
    type RichMediaApi,
    type TicketApi,
    type WebApi,
} from "@napuketto/kernel";
import { describe, expect, it, vi } from "vitest";
import { stub } from "../../../core/__tests__/stub.js";
import { MilkyApi } from "../../api.js";
import { MessageSeqIndex } from "../../helper/state/seq-index.js";
import type { MilkyLoggerLike } from "../../transport.js";
import type { OutgoingSegment } from "../../types.js";
import { sendMilkyMessage } from "../message-send.js";
import { actionOf, indexableMsg, messageApi } from "./test-support.js";

const PEER: Peer = { chatType: ChatType.GROUP, peerUid: "10001" };

/** 发送成功回查用的 RawMessage（回查输出断言）。 */
function sentMsg(seq: string, time: string): RawMessage {
    return {
        msgId: "sent-1",
        msgSeq: seq,
        msgTime: time,
        msgType: 0,
        chatType: ChatType.GROUP,
        peerUid: "10001",
        peerUin: "10001",
        senderUid: "self-uid",
        senderUin: "10000",
        peerName: "测试群",
        sendNickName: "机器人",
        elements: [{ elementType: 1, textElement: { content: "hi" } }],
    };
}

/** 构造 MilkyApi（kernel apis 桩：uinToUid 桩映射 + sendMessage 捕获）。 */
function makeSendApi(): { api: MilkyApi; sentElements: () => CanonicalElement[] } {
    let captured: CanonicalElement[] = [];
    const api = new MilkyApi(
        stub<ConstructorParameters<typeof MilkyApi>[0]>({
            msgApi: stub<MsgApi>({
                sendMessage: vi.fn(async (_peer: Peer, elements: CanonicalElement[]) => {
                    captured = elements;
                    return { msgId: "sent-1" };
                }),
                fetchMsgsByMsgId: vi.fn(async () => [sentMsg("1300", "1760000000000")]),
                fetchMessages: vi.fn(async () => []),
            }),
            groupApi: stub<GroupApi>({
                uinToUid: vi.fn(
                    async (uins: string[]) => new Map(uins.map((u) => [u, `uid-${u}`])),
                ),
                uidToUin: vi.fn(async () => new Map()),
            }),
            friendApi: stub<FriendApi>({}),
            profileApi: stub<ProfileApi>({}),
            self: { uin: "10000", nickname: "机器人" },
            system: undefined,
        }),
        new MessageSeqIndex(),
    );
    return { api, sentElements: () => captured };
}

describe("sendMilkyMessage", () => {
    it("text + mention：canonical 直映射，at uin→uid 批量转换", async () => {
        const { api, sentElements } = makeSendApi();
        await sendMilkyMessage(
            { chatType: ChatType.GROUP, peerUid: "10001" },
            [
                { type: "text", data: { text: "你好 " } },
                { type: "mention", data: { user_id: 90001 } },
                { type: "mention_all", data: {} },
            ],
            api,
        );
        // 桩捕获的是 sendMessage 入参 = canonical 元素（NT 转换在 kernel 内部）
        expect(sentElements()).toEqual([
            { type: "text", text: "你好 " },
            { type: "at", target: "uid-90001" },
            { type: "at", target: "all" },
        ]);
    });

    it("输出 = 发送回查的 message_seq/time", async () => {
        const { api } = makeSendApi();
        const out = await sendMilkyMessage(
            { chatType: ChatType.GROUP, peerUid: "10001" },
            [{ type: "text", data: { text: "hi" } }],
            api,
        );
        expect(out).toEqual({ message_seq: 1300, time: 1760000000 });
    });

    it("未知段跳过；全部不可用抛 INVALID_PARAM", async () => {
        const { api } = makeSendApi();
        await expect(
            sendMilkyMessage(
                { chatType: ChatType.GROUP, peerUid: "10001" },
                [{ type: "no_such_segment", data: {} } as never],
                api,
            ),
        ).rejects.toMatchObject({ code: "INVALID_PARAM" });
    });

    it("reply：seq 原样透传给 canonical（msgId 反查由接收索引/命中兜底）", async () => {
        const { api, sentElements } = makeSendApi();
        await sendMilkyMessage(
            { chatType: ChatType.GROUP, peerUid: "10001" },
            [{ type: "reply", data: { message_seq: 1299 } }],
            api,
        );
        const [replyEl] = sentElements();
        expect(replyEl).toEqual({ type: "reply", messageId: "1299" });
    });
});

/** 发送成功回查用的 RawMessage（forward 组装链版，msgId fw-1）。 */
function fwSentMsg(seq: string, time: string): RawMessage {
    return {
        msgId: "fw-1",
        msgSeq: seq,
        msgTime: time,
        msgType: 0,
        chatType: ChatType.GROUP,
        peerUid: "10001",
        peerUin: "10001",
        senderUid: "self-uid",
        senderUin: "10000",
        peerName: "测试群",
        sendNickName: "机器人",
        elements: [],
    };
}

/** forward 载荷快捷构造（负例故意带畸形 data，运行时收窄拦截）。 */
function forwardSeg(data: Record<string, unknown>): OutgoingSegment {
    return { type: "forward", data } as unknown as OutgoingSegment;
}

/** 构造 MilkyApi（组装链依赖桩 + 调用捕获）。 */
function makeApi(): {
    api: MilkyApi;
    sends: CanonicalElement[][];
    forwardCalls: Array<{ target: Peer; source: Peer; srcMsgIds: string[] }>;
    recallCalls: string[][];
    warns: unknown[];
    recallMock: ReturnType<typeof vi.fn>;
} {
    const sends: CanonicalElement[][] = [];
    const forwardCalls: Array<{ target: Peer; source: Peer; srcMsgIds: string[] }> = [];
    const recallCalls: string[][] = [];
    const warns: unknown[] = [];
    let sendSeq = 0;
    const recallMock = vi.fn(async (_peer: Peer, msgIds: string[]) => {
        recallCalls.push(msgIds);
    });
    const api = new MilkyApi(
        stub<ConstructorParameters<typeof MilkyApi>[0]>({
            msgApi: stub<MsgApi>({
                sendMessage: vi.fn(async (_peer: Peer, elements: CanonicalElement[]) => {
                    sends.push(elements);
                    sendSeq += 1;
                    return { msgId: `tmp-${sendSeq}` };
                }),
                sendForwardMessage: vi.fn(
                    async (target: Peer, source: Peer, srcMsgIds: string[]) => {
                        forwardCalls.push({ target, source, srcMsgIds });
                        return { msgId: "fw-1" };
                    },
                ),
                recallMessage: recallMock,
                fetchMsgsByMsgId: vi.fn(async () => [fwSentMsg("777", "1700000000000")]),
            }),
            groupApi: stub<GroupApi>({
                uinToUid: vi.fn(
                    async (uins: string[]) => new Map(uins.map((u) => [u, `uid-${u}`])),
                ),
            }),
            friendApi: stub<FriendApi>({}),
            profileApi: stub<ProfileApi>({}),
            profileLikeApi: stub<ProfileLikeApi>({}),
            ticketApi: stub<TicketApi>({}),
            webApi: stub<WebApi>({}),
            groupNotifyApi: stub<GroupNotifyApi>({}),
            richMediaApi: stub<RichMediaApi>({}),
            self: { uin: "10000", nickname: "机器人", uid: "uid-10000" },
            qqVersion: "9.9.9",
            implVersion: "test",
            logger: stub<MilkyLoggerLike>({
                warn: vi.fn((obj: unknown) => warns.push(obj)),
                info: vi.fn(),
            }),
        }),
        new MessageSeqIndex(),
    );
    return { api, sends, forwardCalls, recallCalls, warns, recallMock };
}

describe("sendMilkyMessage forward 组装链（P2 批次一）", () => {
    it("两条节点：临时发送 ×2 → 组装转发 → 撤回临时 → 回查输出", async () => {
        const { api, sends, forwardCalls, recallCalls } = makeApi();
        const out = await sendMilkyMessage(
            PEER,
            [
                forwardSeg({
                    messages: [
                        {
                            user_id: 20002,
                            sender_name: "甲",
                            segments: [{ type: "text", data: { text: "早上好" } }],
                        },
                        {
                            user_id: 30003,
                            sender_name: "乙",
                            segments: [{ type: "text", data: { text: "中午好" } }],
                        },
                    ],
                    title: "聊天记录",
                }),
            ],
            api,
        );
        expect(sends).toHaveLength(2);
        expect(forwardCalls).toEqual([
            { target: PEER, source: PEER, srcMsgIds: ["tmp-1", "tmp-2"] },
        ]);
        expect(recallCalls).toEqual([["tmp-1", "tmp-2"]]);
        expect(out).toEqual({ message_seq: 777, time: 1700000000 });
    });

    it("与其他消息段混发：INVALID_PARAM", async () => {
        const { api, sends } = makeApi();
        await expect(
            sendMilkyMessage(
                PEER,
                [
                    { type: "text", data: { text: "前缀" } },
                    forwardSeg({
                        messages: [
                            {
                                user_id: 20002,
                                sender_name: "甲",
                                segments: [{ type: "text", data: { text: "x" } }],
                            },
                        ],
                    }),
                ],
                api,
            ),
        ).rejects.toMatchObject({ code: "INVALID_PARAM" });
        expect(sends).toHaveLength(0);
    });

    it("messages 空数组：INVALID_PARAM", async () => {
        const { api } = makeApi();
        await expect(
            sendMilkyMessage(PEER, [forwardSeg({ messages: [] })], api),
        ).rejects.toMatchObject({ code: "INVALID_PARAM" });
    });

    it("项 segments 为空：INVALID_PARAM", async () => {
        const { api } = makeApi();
        await expect(
            sendMilkyMessage(
                PEER,
                [
                    forwardSeg({
                        messages: [{ user_id: 20002, sender_name: "甲", segments: [] }],
                    }),
                ],
                api,
            ),
        ).rejects.toMatchObject({ code: "INVALID_PARAM" });
    });

    it("嵌套 forward 段：INVALID_PARAM（组装链内逐项转换拒绝）", async () => {
        const { api } = makeApi();
        await expect(
            sendMilkyMessage(
                PEER,
                [
                    forwardSeg({
                        messages: [
                            {
                                user_id: 20002,
                                sender_name: "甲",
                                segments: [
                                    forwardSeg({
                                        messages: [
                                            {
                                                user_id: 30003,
                                                sender_name: "乙",
                                                segments: [{ type: "text", data: { text: "x" } }],
                                            },
                                        ],
                                    }),
                                ],
                            },
                        ],
                    }),
                ],
                api,
            ),
        ).rejects.toMatchObject({ code: "INVALID_PARAM" });
    });

    it("节点段全部不可用（未知段跳过）：INVALID_PARAM", async () => {
        const { api, sends } = makeApi();
        await expect(
            sendMilkyMessage(
                PEER,
                [
                    forwardSeg({
                        messages: [
                            {
                                user_id: 20002,
                                sender_name: "甲",
                                segments: [{ type: "mystery", data: {} }],
                            },
                        ],
                    }),
                ],
                api,
            ),
        ).rejects.toMatchObject({ code: "INVALID_PARAM" });
        expect(sends).toHaveLength(0);
    });

    it("撤回失败 best-effort：warn 记录后输出照常返回", async () => {
        const { api, warns, forwardCalls, recallMock } = makeApi();
        recallMock.mockRejectedValueOnce(new Error("recall denied"));
        const out = await sendMilkyMessage(
            PEER,
            [
                forwardSeg({
                    messages: [
                        {
                            user_id: 20002,
                            sender_name: "甲",
                            segments: [{ type: "text", data: { text: "x" } }],
                        },
                    ],
                }),
            ],
            api,
        );
        expect(out).toEqual({ message_seq: 777, time: 1700000000 });
        expect(forwardCalls).toHaveLength(1);
        expect(warns).toEqual([{ peer: "10001", count: 1, error: "recall denied" }]);
    });

    it("附加字段 title/preview/summary/prompt 容忍不抛", async () => {
        const { api } = makeApi();
        await expect(
            sendMilkyMessage(
                PEER,
                [
                    forwardSeg({
                        messages: [
                            {
                                user_id: 20002,
                                sender_name: "甲",
                                time: 1700000000,
                                segments: [{ type: "text", data: { text: "x" } }],
                            },
                        ],
                        title: "标题",
                        preview: ["预览"],
                        summary: "查看 1 条转发消息",
                        prompt: "[聊天记录]",
                    }),
                ],
                api,
            ),
        ).resolves.toEqual({ message_seq: 777, time: 1700000000 });
    });
});

describe("send_private_message / send_group_message（动作层）", () => {
    it("file:// 媒体段：同步展开为平台路径（不触下载）", async () => {
        const sendMessage = vi.fn(async (_peer: Peer, _elements: CanonicalElement[]) => ({
            msgId: "sent-1",
        }));
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
        const [peer, elements] = sendMessage.mock.calls[0] ?? [];
        expect(peer).toEqual({ chatType: ChatType.GROUP, peerUid: "10001" });
        const image = elements?.[1];
        expect(image?.type === "image" && image.path.endsWith("x.png")).toBe(true);
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
        const sendMessage = vi.fn(async (_peer: Peer, _elements: CanonicalElement[]) => ({
            msgId: "sent-1",
        }));
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
        const elements = (sendMessage.mock.calls[0] ?? [])[1];
        expect(elements?.[0]).toEqual({ type: "at", target: "90001" });
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
        const sendMessage = vi.fn(async (_peer: Peer, _elements: CanonicalElement[]) => ({
            msgId: "sent-1",
        }));
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
        expect(sendMessage.mock.calls[0]?.[0]).toEqual({
            chatType: ChatType.C2C,
            peerUid: "uid-20002",
        });
        expect(res.data).toEqual({ message_seq: 77, time: 1760000000 });
    });

    it("at uinToUid 抛错 → 目标保持 uin 原样（catch → undefined 映射）", async () => {
        const sendMessage = vi.fn(async (_peer: Peer, _elements: CanonicalElement[]) => ({
            msgId: "sent-1",
        }));
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
        const elements = (sendMessage.mock.calls[0] ?? [])[1];
        expect(elements?.[0]).toEqual({ type: "at", target: "90001" });
    });
});

describe("forward messages 项防御（补组装链未覆盖分支）", () => {
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
