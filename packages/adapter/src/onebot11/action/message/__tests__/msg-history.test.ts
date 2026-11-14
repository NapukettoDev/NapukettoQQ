/**
 * 历史消息动作测试：msg-history 共享核心（fetchAndTranslateHistory）+
 * get_group_msg_history / get_friend_msg_history 两个入口。
 *
 * 锁定行为：message_seq（OB11 id 经 MessageUnique 反查 / NT msgId 原样）→ 起始
 * msgId、count 缺省 20、空结果 → NOT_FOUND、at uid 批量 uidToUin（失败原样）、
 * 群聊 senderRole 注入（GroupCache 角色表）、私聊不查角色。
 */
import { ChatType, type RawMessage } from "@napuketto/kernel";
import { describe, expect, it, vi } from "vitest";
import type { GroupSenderRole } from "../../../helper/data.js";
import { MessageUnique } from "../../../helper/message-unique.js";
import {
    GetFriendMsgHistoryAction,
    GetGroupMsgHistoryAction,
    type MsgHistoryDeps,
} from "../history.js";

/** 文本消息 RawMessage 桩（可带 at 元素）。 */
function rawMsg(overrides: {
    msgId: string;
    msgSeq: string;
    senderUin?: string;
    senderUid?: string;
    peerUid?: string;
    chatType?: number;
    atUid?: string;
    replyId?: string;
    sendMemberName?: string;
}): RawMessage {
    return {
        msgId: overrides.msgId,
        msgSeq: overrides.msgSeq,
        msgTime: "1700000000000",
        msgType: 2,
        chatType: overrides.chatType ?? ChatType.GROUP,
        peerUid: overrides.peerUid ?? "808",
        peerUin: overrides.peerUid ?? "808",
        senderUid: overrides.senderUid ?? "u90002",
        senderUin: overrides.senderUin ?? "90002",
        peerName: "群",
        sendNickName: "某人",
        sendMemberName: overrides.sendMemberName,
        elements: [
            ...(overrides.atUid !== undefined
                ? [
                      {
                          elementType: 1,
                          textElement: { content: "@某人", atType: 2, atUid: overrides.atUid },
                      },
                  ]
                : []),
            ...(overrides.replyId !== undefined
                ? [{ elementType: 7, replyElement: { replayMsgId: overrides.replyId } }]
                : []),
            { elementType: 1, textElement: { content: "正文" } },
        ],
    } as unknown as RawMessage;
}

/** 构造历史消息依赖桩（msgApi.fetchMessages / uidToUin / groupMemberRoles 可控）。 */
function makeDeps(options?: {
    msgs?: RawMessage[];
    uidToUinFail?: boolean;
    roles?: Map<string, GroupSenderRole>;
}): {
    deps: MsgHistoryDeps;
    fetchMessages: ReturnType<typeof vi.fn>;
    uidToUin: ReturnType<typeof vi.fn>;
} {
    const fetchMessages =
        options?.msgs !== undefined
            ? vi.fn(async () => options.msgs)
            : vi.fn(async () => [] as RawMessage[]);
    const uidToUin = vi.fn(async (uids: string[]) => {
        if (options?.uidToUinFail === true) {
            throw new Error("转换服务不可用");
        }
        return new Map(uids.map((u) => [u, u.replace("u", "")]));
    });
    const deps: MsgHistoryDeps = {
        msgApi: { fetchMessages } as never,
        messageUnique: new MessageUnique(),
        uidToUin,
        groupMemberRoles:
            options?.roles !== undefined
                ? vi.fn(async (_group: string) => options.roles)
                : vi.fn(
                      async (_group: string): Promise<Map<string, GroupSenderRole> | undefined> =>
                          undefined,
                  ),
    };
    return { deps, fetchMessages, uidToUin };
}

describe("fetchAndTranslateHistory（get_group_msg_history）", () => {
    it("缺省从最新拉（无 msgId 选项）→ 消息翻译为 OB11 信息", async () => {
        const { deps, fetchMessages } = makeDeps({
            msgs: [rawMsg({ msgId: "nt-a", msgSeq: "5" })],
        });
        const action = new GetGroupMsgHistoryAction(deps);
        const result = await action.handle({ group_id: 808 });
        expect(result.status).toBe("ok");
        expect(fetchMessages).toHaveBeenCalledWith(
            { chatType: ChatType.GROUP, peerUid: "808" },
            { count: 20 },
        );
        expect(result.data?.messages).toHaveLength(1);
        const [msg] = result.data?.messages ?? [];
        expect(msg).toMatchObject({
            message_type: "group",
            group_id: 808,
            sender: { user_id: 90002, nickname: "某人", role: "member" },
            raw_message: "正文",
        });
    });

    it("count 自定义 + message_seq（OB11 id）→ MessageUnique 反查起始 msgId", async () => {
        const { deps, fetchMessages } = makeDeps({
            msgs: [rawMsg({ msgId: "nt-b", msgSeq: "6" })],
        });
        deps.messageUnique.alloc("nt-anchor", { chatType: ChatType.GROUP, peerUid: "808" });
        const action = new GetGroupMsgHistoryAction(deps);
        await action.handle({ group_id: 808, count: 5, message_seq: 1 });
        expect(fetchMessages).toHaveBeenCalledWith(
            { chatType: ChatType.GROUP, peerUid: "808" },
            { count: 5, msgId: "nt-anchor" },
        );
    });

    it("message_seq 反查不到 → 原样透传（兼容 NT msgId 直传）", async () => {
        const { deps, fetchMessages } = makeDeps({
            msgs: [rawMsg({ msgId: "nt-c", msgSeq: "7" })],
        });
        const action = new GetGroupMsgHistoryAction(deps);
        await action.handle({ group_id: 808, message_seq: "raw-nt-id" });
        expect(fetchMessages).toHaveBeenCalledWith(
            { chatType: ChatType.GROUP, peerUid: "808" },
            { count: 20, msgId: "raw-nt-id" },
        );
    });

    it("message_seq 为数值但未登记 → 反查 undefined 回退数值串原文", async () => {
        const { deps, fetchMessages } = makeDeps();
        const action = new GetGroupMsgHistoryAction(deps);
        await action.handle({ group_id: 808, message_seq: 987654 });
        // 987654 未登记 → 反查 undefined → 回退数值串原文作 msgId 锚点
        expect(fetchMessages).toHaveBeenCalledWith(
            expect.objectContaining({ peerUid: "808" }),
            expect.objectContaining({ msgId: "987654" }),
        );
    });

    it("拉取结果为空 → retcode 102 NOT_FOUND", async () => {
        const { deps } = makeDeps({ msgs: [] });
        const action = new GetGroupMsgHistoryAction(deps);
        const result = await action.handle({ group_id: 808 });
        expect(result.retcode).toBe(102);
        expect(result.message).toBe("消息 0 不存在");
    });

    it("群聊：senderRole 经 groupMemberRoles 注入（owner 角色回填）", async () => {
        const { deps } = makeDeps({
            msgs: [rawMsg({ msgId: "nt-d", msgSeq: "8", senderUid: "u90001" })],
            roles: new Map([["u90001", "owner"]]),
        });
        const action = new GetGroupMsgHistoryAction(deps);
        const result = await action.handle({ group_id: 808 });
        expect(result.data?.messages[0]?.sender).toMatchObject({ role: "owner" });
    });

    it("at 元素：uid 批量转换一次；转换失败 → at 原样（uid）", async () => {
        const { deps, uidToUin } = makeDeps({
            msgs: [
                rawMsg({ msgId: "nt-e", msgSeq: "9", atUid: "u90002" }),
                rawMsg({ msgId: "nt-f", msgSeq: "10", atUid: "u90002" }),
            ],
        });
        const action = new GetGroupMsgHistoryAction(deps);
        const result = await action.handle({ group_id: 808 });
        expect(uidToUin).toHaveBeenCalledTimes(1);
        expect(uidToUin).toHaveBeenCalledWith(["u90002"]);
        const [first] = result.data?.messages ?? [];
        expect(
            (first?.message as Array<{ type: string; data: { qq?: string } }> | undefined)?.[0],
        ).toMatchObject({
            type: "at",
            data: { qq: "90002" },
        });
        // 同一去重集合（两次出现只转一次）
        expect(uidToUin.mock.calls[0]?.[0]).toHaveLength(1);
    });

    it("uidToUin 抛错 → at 保留 uid，不阻塞历史返回", async () => {
        const { deps, uidToUin } = makeDeps({
            msgs: [rawMsg({ msgId: "nt-g", msgSeq: "11", atUid: "u90002" })],
            uidToUinFail: true,
        });
        const action = new GetGroupMsgHistoryAction(deps);
        const result = await action.handle({ group_id: 808 });
        expect(result.retcode).toBe(0);
        expect(uidToUin).toHaveBeenCalledTimes(1);
        const [first] = result.data?.messages ?? [];
        expect(
            (first?.message as Array<{ type: string; data: { qq?: string } }> | undefined)?.[0]
                ?.data["qq"],
        ).toBe("u90002");
    });
});

describe("历史消息 reply / 群名片映射", () => {
    it("reply 元素 → MessageUnique 反查 OB11 id；sendMemberName → sender.card", async () => {
        const { deps } = makeDeps({
            msgs: [
                rawMsg({
                    msgId: "nt-r",
                    msgSeq: "20",
                    atUid: "u90002",
                    replyId: "nt-anchor2",
                    sendMemberName: "名片乙",
                }),
            ],
        });
        deps.messageUnique.alloc("nt-anchor2", { chatType: ChatType.GROUP, peerUid: "808" });
        const action = new GetGroupMsgHistoryAction(deps);
        const result = await action.handle({ group_id: 808 });
        const [msg] = result.data?.messages ?? [];
        const segments = msg?.message as Array<{ type: string; data: Record<string, unknown> }>;
        expect(segments.find((s) => s.type === "reply")).toMatchObject({
            type: "reply",
            data: { id: "1" },
        });
        expect(msg?.sender).toMatchObject({ card: "名片乙" });
    });
});

describe("get_friend_msg_history", () => {
    it("user_id uin→uid → Peer{C2C}；不查群角色表", async () => {
        const { deps, fetchMessages } = makeDeps({
            msgs: [
                rawMsg({
                    msgId: "nt-h",
                    msgSeq: "12",
                    chatType: ChatType.C2C,
                    peerUid: "u90001",
                }),
            ],
        });
        const groupMemberRoles = vi.fn(async () => undefined);
        (deps as { groupMemberRoles: unknown }).groupMemberRoles = groupMemberRoles;
        (deps as unknown as { uinToUid: unknown }).uinToUid = vi.fn(
            async () => new Map([["90001", "u90001"]]),
        );
        const action = new GetFriendMsgHistoryAction(
            deps as MsgHistoryDeps & { uinToUid: (uins: string[]) => Promise<Map<string, string>> },
        );
        const result = await action.handle({ user_id: 90001 });
        expect(result.retcode).toBe(0);
        expect(fetchMessages).toHaveBeenCalledWith(
            { chatType: ChatType.C2C, peerUid: "u90001" },
            { count: 20 },
        );
        expect(groupMemberRoles).not.toHaveBeenCalled();
        const [msg] = result.data?.messages ?? [];
        expect(msg).toMatchObject({ message_type: "private", user_id: 90002 });
    });

    it("user_id 解析失败 → retcode 105", async () => {
        const { deps } = makeDeps({ msgs: [] });
        const action = new GetFriendMsgHistoryAction(
            deps as MsgHistoryDeps & { uinToUid: (uins: string[]) => Promise<Map<string, string>> },
        );
        (deps as unknown as { uinToUid: unknown }).uinToUid = vi.fn(
            async () => new Map<string, string>(),
        );
        const result = await action.handle({ user_id: 11111 });
        expect(result.retcode).toBe(105);
    });
});
