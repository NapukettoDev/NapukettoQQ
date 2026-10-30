/**
 * Milky P2 批次一动作测试：forward 发送段组装链（sendMilkyMessage 分流）
 *
 * kernel apis 桩：msgApi（sendMessage / sendForwardMessage / recallMessage /
 * fetchMsgsByMsgId）+ groupApi（uinToUid）+ logger。
 * 锁定：临时消息法调用序列（临时发送 → 组装转发 → 撤回）、载荷收窄
 * （空 messages / 项 segments 空 / 嵌套 forward / 混发均 -400）、撤回失败
 * best-effort（warn 不抛）、附加字段容忍。
 */
import { ChatType, type Peer, type RawMessage } from "@napuketto/kernel";
import { describe, expect, it, vi } from "vitest";
import { MilkyApi } from "../api.js";
import { MessageSeqIndex } from "../helper/seq-index.js";
import type { OutgoingSegment } from "../types.js";
import { sendMilkyMessage } from "./message.js";

const PEER: Peer = { chatType: ChatType.GROUP, peerUid: "10001" };

/** 发送成功回查用的 RawMessage（message.test.ts 同款）。 */
function sentMsg(seq: string, time: string): RawMessage {
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
    sends: RawMessage["elements"][];
    forwardCalls: Array<{ target: Peer; source: Peer; srcMsgIds: string[] }>;
    recallCalls: string[][];
    warns: unknown[];
    recallMock: ReturnType<typeof vi.fn>;
} {
    const sends: RawMessage["elements"][] = [];
    const forwardCalls: Array<{ target: Peer; source: Peer; srcMsgIds: string[] }> = [];
    const recallCalls: string[][] = [];
    const warns: unknown[] = [];
    let sendSeq = 0;
    const recallMock = vi.fn(async (_peer: Peer, msgIds: string[]) => {
        recallCalls.push(msgIds);
    });
    const api = new MilkyApi(
        {
            msgApi: {
                sendMessage: vi.fn(async (_peer: Peer, elements: RawMessage["elements"]) => {
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
                fetchMsgsByMsgId: vi.fn(async () => [sentMsg("777", "1700000000000")]),
            },
            groupApi: {
                uinToUid: vi.fn(
                    async (uins: string[]) => new Map(uins.map((u) => [u, `uid-${u}`])),
                ),
            },
            friendApi: {},
            profileApi: {},
            profileLikeApi: {},
            ticketApi: {},
            webApi: {},
            groupNotifyApi: {},
            richMediaApi: {},
            self: { uin: "10000", nickname: "机器人", uid: "uid-10000" },
            qqVersion: "9.9.9",
            implVersion: "test",
            logger: { warn: vi.fn((obj: unknown) => warns.push(obj)), info: vi.fn() },
        } as unknown as ConstructorParameters<typeof MilkyApi>[0],
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
