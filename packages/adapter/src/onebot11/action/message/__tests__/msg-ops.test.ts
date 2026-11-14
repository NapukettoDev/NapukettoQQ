/**
 * 消息操作动作测试：resolve-peer 共享核心 + get_msg / delete_msg / fetch_ptt_text /
 * set_msg_emoji_like / set_input_status / mark_msg_as_read（含私聊/群聊别名）。
 *
 * 锁定行为：resolveTargetPeer 三分支（群直通 / uin→uid / 缺参报错）、fetchMsgById
 * 空结果 → NOT_FOUND、get_msg 的 at 转换与群角色注入、表情表态 msgSeq 透传与
 * emoji_type/like 缺省、输入状态事件类型缺省 1、mark_read 群/私聊分流与缺参 400。
 */
import { ChatType, type RawMessage } from "@napuketto/kernel";
import { describe, expect, it, vi } from "vitest";
import { stub } from "../../../../shared/__tests__/stub.js";
import { MessageUnique } from "../../../helper/message-unique.js";
import type { OB11MessageInfo } from "../../../types/index.js";
import { ob11ActionOf } from "../../__tests__/test-support.js";
import type { Ob11Action } from "../../base-action.js";
import { createHistoryActions } from "../history.js";
import { createMediaActions } from "../media.js";
import { createMsgOpsActions } from "../ops.js";
import { fetchMsgById, resolveTargetPeer } from "../resolve-peer.js";

/** 取 get_msg 动作（TReturn 断言为 OB11MessageInfo，保持 result.data 属性访问的编译期类型）。 */
function getMsgActionOf(deps: unknown): Ob11Action<unknown, OB11MessageInfo> {
    return ob11ActionOf(createHistoryActions(deps as never), "get_msg") as Ob11Action<
        unknown,
        OB11MessageInfo
    >;
}

/** 群文本消息 RawMessage 桩。 */
function rawMsg(overrides?: { atUid?: string; chatType?: ChatType; msgSeq?: string }): RawMessage {
    return stub<RawMessage>({
        msgId: "nt-1",
        msgSeq: overrides?.msgSeq ?? "42",
        msgTime: "1700000000000",
        msgType: 2,
        chatType: overrides?.chatType ?? ChatType.GROUP,
        peerUid: "808",
        peerUin: "808",
        senderUid: "u90002",
        senderUin: "90002",
        peerName: "群",
        sendNickName: "某人",
        elements: [
            ...(overrides?.atUid !== undefined
                ? [
                      {
                          elementType: 1,
                          textElement: { content: "@甲", atType: 2, atUid: overrides.atUid },
                      },
                  ]
                : []),
            { elementType: 1, textElement: { content: "正文" } },
        ],
    });
}

/** 构造消息操作依赖（真实 MessageUnique + 各 MsgApi 方法桩）。 */
function makeDeps(options?: { msgs?: RawMessage[]; uinMap?: Record<string, string> }) {
    const fetchMsgsByMsgId =
        options?.msgs !== undefined
            ? vi.fn(async () => options.msgs)
            : vi.fn(async () => [] as RawMessage[]);
    const uinToUid = vi.fn(async (uins: string[]) => {
        const table = options?.uinMap ?? { "90001": "u90001", "90002": "u90002" };
        return new Map(uins.filter((u) => u in table).map((u) => [u, table[u] as string]));
    });
    const uidToUin = vi.fn(
        async (uids: string[]) => new Map(uids.map((u) => [u, u.replace("u", "")])),
    );
    const msgApi = {
        fetchMsgsByMsgId,
        recallMessage: vi.fn(async () => undefined),
        fetchPttText: vi.fn(async () => "转写文本"),
        setMsgEmojiLike: vi.fn(async () => undefined),
        setInputStatus: vi.fn(async () => undefined),
        markRead: vi.fn(async () => undefined),
    };
    const deps = {
        msgApi,
        messageUnique: new MessageUnique(),
        uinToUid,
        uidToUin,
        groupMemberRole: vi.fn(async () => undefined),
    };
    return deps;
}

describe("resolveTargetPeer / fetchMsgById（共享核心）", () => {
    it("group_id 直通 GROUP Peer；user_id 经 uin→uid", async () => {
        const deps = makeDeps();
        expect(await resolveTargetPeer({ group_id: 808 }, deps, "需要目标")).toEqual({
            chatType: ChatType.GROUP,
            peerUid: "808",
        });
        expect(await resolveTargetPeer({ user_id: 90001 }, deps, "需要目标")).toEqual({
            chatType: ChatType.C2C,
            peerUid: "u90001",
        });
    });

    it("user_id 解析不到 → KernelError INVALID_PARAM；两者都缺 → 自定义提示", async () => {
        const deps = makeDeps({ uinMap: {} });
        await expect(resolveTargetPeer({ user_id: 11111 }, deps, "需要目标")).rejects.toMatchObject(
            {
                code: "INVALID_PARAM",
            },
        );
        await expect(resolveTargetPeer({}, deps, "缺目标提示")).rejects.toMatchObject({
            message: "缺目标提示",
        });
    });

    it("fetchMsgById：命中返回 msg/peer/msgId；空结果 → NOT_FOUND", async () => {
        const deps = makeDeps({ msgs: [rawMsg()] });
        deps.messageUnique.alloc("nt-1", { chatType: ChatType.GROUP, peerUid: "808" });
        const hit = await fetchMsgById(1, deps.messageUnique, deps.msgApi as never);
        expect(hit.msgId).toBe("nt-1");
        expect(hit.msg.msgId).toBe("nt-1");
        await expect(
            fetchMsgById(1, new MessageUnique(), deps.msgApi as never),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("fetchMsgById：消息已登记但 fetch 返回空 → NOT_FOUND「不存在或已被撤回」", async () => {
        const deps = makeDeps({ msgs: [] });
        deps.messageUnique.alloc("nt-1", { chatType: ChatType.GROUP, peerUid: "808" });
        await expect(
            fetchMsgById(1, deps.messageUnique, deps.msgApi as never),
        ).rejects.toMatchObject({ message: "消息 1 不存在或已被撤回" });
    });
});

describe("get_msg", () => {
    it("群消息 → OB11 信息 + senderRole 注入 + at uid 转换", async () => {
        const deps = makeDeps({ msgs: [rawMsg({ atUid: "u90001" })] });
        (deps as { groupMemberRole: unknown }).groupMemberRole = vi.fn(async () => "admin");
        deps.messageUnique.alloc("nt-1", { chatType: ChatType.GROUP, peerUid: "808" });
        const action = getMsgActionOf(deps);
        const result = await action.handle({ message_id: 1 });
        expect(result.status).toBe("ok");
        expect(result.data).toMatchObject({
            message_id: 1,
            message_type: "group",
            group_id: 808,
            sender: { user_id: 90002, nickname: "某人", role: "admin" },
        });
        expect(
            (
                result.data?.message as
                    | Array<{ type: string; data: Record<string, unknown> }>
                    | undefined
            )?.[0],
        ).toEqual({
            type: "at",
            data: { qq: "90001", name: "甲" },
        });
        expect(deps.groupMemberRole).toHaveBeenCalledWith("808", "u90002");
    });

    it("私聊消息 → 不查角色（sub_type private、无 group_id）", async () => {
        const deps = makeDeps({
            msgs: [rawMsg({ chatType: ChatType.C2C })],
        });
        deps.messageUnique.alloc("nt-1", { chatType: ChatType.C2C, peerUid: "u90001" });
        const action = getMsgActionOf(deps);
        const result = await action.handle({ message_id: 1 });
        expect(result.data).toMatchObject({ message_type: "private", user_id: 90002 });
        expect(deps.groupMemberRole).not.toHaveBeenCalled();
        expect(result.data?.sender).not.toHaveProperty("role");
    });

    it("reply 元素 → NT msgId 反查 OB11 message_id（映射不到原样）", async () => {
        const msg = {
            ...rawMsg(),
            elements: [
                { elementType: 7, replyElement: { replayMsgId: "nt-src" } },
                { elementType: 7, replyElement: { replayMsgId: "nt-unmapped" } },
            ],
        } as RawMessage;
        const deps = makeDeps({ msgs: [msg] });
        deps.messageUnique.alloc("nt-1", { chatType: ChatType.GROUP, peerUid: "808" });
        deps.messageUnique.alloc("nt-src", { chatType: ChatType.GROUP, peerUid: "808" });
        const action = getMsgActionOf(deps);
        const result = await action.handle({ message_id: 1 });
        const segments = result.data?.message as Array<{ type: string; data: { id?: string } }>;
        expect(segments[0]).toEqual({ type: "reply", data: { id: "2" } });
        expect(segments[1]).toEqual({ type: "reply", data: { id: "nt-unmapped" } });
    });

    it("消息不存在（MessageUnique 未登记）→ retcode 102", async () => {
        const deps = makeDeps({ msgs: [] });
        const action = getMsgActionOf(deps);
        expect((await action.handle({ message_id: 42 })).retcode).toBe(102);
    });
});

describe("delete_msg", () => {
    it("message_id 反查 → recallMessage(peer, [msgId])", async () => {
        const deps = makeDeps();
        deps.messageUnique.alloc("nt-1", { chatType: ChatType.GROUP, peerUid: "808" });
        const action = ob11ActionOf(createMsgOpsActions(deps as never), "delete_msg");
        const result = await action.handle({ message_id: "1" });
        expect(result.retcode).toBe(0);
        expect(deps.msgApi.recallMessage).toHaveBeenCalledWith(
            { chatType: ChatType.GROUP, peerUid: "808" },
            ["nt-1"],
        );
    });

    it("message_id 未登记 → retcode 102", async () => {
        const action = ob11ActionOf(createMsgOpsActions(makeDeps() as never), "delete_msg");
        expect((await action.handle({ message_id: 999 })).retcode).toBe(102);
    });
});

describe("fetch_ptt_text", () => {
    it("message_id 反查 → fetchPttText(msgId, peer) → { text }", async () => {
        const deps = makeDeps();
        deps.messageUnique.alloc("nt-1", { chatType: ChatType.C2C, peerUid: "u90001" });
        const action = ob11ActionOf(createMediaActions(deps as never), "fetch_ptt_text");
        const result = await action.handle({ message_id: 1 });
        expect(result.data).toEqual({ text: "转写文本" });
        expect(deps.msgApi.fetchPttText).toHaveBeenCalledWith("nt-1", {
            chatType: ChatType.C2C,
            peerUid: "u90001",
        });
    });
});

describe("set_msg_emoji_like", () => {
    it("反查消息取 msgSeq → setMsgEmojiLike(peer, msgSeq/emojiId/type/like)", async () => {
        const deps = makeDeps({ msgs: [rawMsg()] });
        deps.messageUnique.alloc("nt-1", { chatType: ChatType.GROUP, peerUid: "808" });
        const action = ob11ActionOf(createMsgOpsActions(deps as never), "set_msg_emoji_like");
        const result = await action.handle({ message_id: 1, emoji_id: 105 });
        expect(result.retcode).toBe(0);
        expect(deps.msgApi.setMsgEmojiLike).toHaveBeenCalledWith(
            { chatType: ChatType.GROUP, peerUid: "808" },
            { msgSeq: "42", emojiId: "105", emojiType: "1", like: true },
        );
    });

    it("emoji_type / like 显式传入透传", async () => {
        const deps = makeDeps({ msgs: [rawMsg()] });
        deps.messageUnique.alloc("nt-1", { chatType: ChatType.GROUP, peerUid: "808" });
        const action = ob11ActionOf(createMsgOpsActions(deps as never), "set_msg_emoji_like");
        await action.handle({ message_id: 1, emoji_id: 4, emoji_type: 2, like: false });
        expect(deps.msgApi.setMsgEmojiLike).toHaveBeenCalledWith(
            { chatType: ChatType.GROUP, peerUid: "808" },
            { msgSeq: "42", emojiId: "4", emojiType: "2", like: false },
        );
    });
});

describe("set_input_status", () => {
    it("user_id → C2C peer；event_type 缺省 1（输入中）", async () => {
        const deps = makeDeps();
        const action = ob11ActionOf(createMsgOpsActions(deps as never), "set_input_status");
        const result = await action.handle({ user_id: 90001 });
        expect(result.retcode).toBe(0);
        expect(deps.msgApi.setInputStatus).toHaveBeenCalledWith(
            { chatType: ChatType.C2C, peerUid: "u90001" },
            1,
        );
    });

    it("event_type=0（停止输入）透传", async () => {
        const deps = makeDeps();
        const action = ob11ActionOf(createMsgOpsActions(deps as never), "set_input_status");
        await action.handle({ user_id: 90001, event_type: 0 });
        expect(deps.msgApi.setInputStatus).toHaveBeenLastCalledWith(
            { chatType: ChatType.C2C, peerUid: "u90001" },
            0,
        );
    });
});

describe("mark_msg_as_read（含细分别名）", () => {
    it("只带 group_id（无 user_id）→ 仅 mark 群（C2C 分支跳过）", async () => {
        const deps = makeDeps();
        const action = ob11ActionOf(createMsgOpsActions(deps as never), "mark_msg_as_read");
        const result = await action.handle({ group_id: 808 });
        expect(result.retcode).toBe(0);
        expect(deps.msgApi.markRead).toHaveBeenCalledTimes(1);
        expect(deps.msgApi.markRead).toHaveBeenCalledWith({
            chatType: ChatType.GROUP,
            peerUid: "808",
        });
    });

    it("group_id 优先 → markRead GROUP peer", async () => {
        const deps = makeDeps();
        const action = ob11ActionOf(createMsgOpsActions(deps as never), "mark_msg_as_read");
        const result = await action.handle({ group_id: 808, user_id: 90001 });
        expect(result.retcode).toBe(0);
        expect(deps.msgApi.markRead).toHaveBeenCalledTimes(1);
        expect(deps.msgApi.markRead).toHaveBeenCalledWith({
            chatType: ChatType.GROUP,
            peerUid: "808",
        });
    });

    it("仅 user_id → uin→uid → markRead C2C peer", async () => {
        const deps = makeDeps();
        const action = ob11ActionOf(createMsgOpsActions(deps as never), "mark_msg_as_read");
        await action.handle({ user_id: 90001 });
        expect(deps.msgApi.markRead).toHaveBeenCalledWith({
            chatType: ChatType.C2C,
            peerUid: "u90001",
        });
    });

    it("user_id 与 group_id 都缺 → retcode 400（refine 校验）", async () => {
        const action = ob11ActionOf(createMsgOpsActions(makeDeps() as never), "mark_msg_as_read");
        expect((await action.handle({})).retcode).toBe(400);
    });

    it("mark_private_msg_as_read 别名 → C2C markRead", async () => {
        const deps = makeDeps();
        const action = ob11ActionOf(createMsgOpsActions(deps as never), "mark_private_msg_as_read");
        const result = await action.handle({ user_id: 90001 });
        expect(result.retcode).toBe(0);
        expect(deps.msgApi.markRead).toHaveBeenCalledWith({
            chatType: ChatType.C2C,
            peerUid: "u90001",
        });
    });

    it("mark_group_msg_as_read 别名 → GROUP markRead", async () => {
        const deps = makeDeps();
        const action = ob11ActionOf(createMsgOpsActions(deps as never), "mark_group_msg_as_read");
        const result = await action.handle({ group_id: 808 });
        expect(result.retcode).toBe(0);
        expect(deps.msgApi.markRead).toHaveBeenCalledWith({
            chatType: ChatType.GROUP,
            peerUid: "808",
        });
    });
});
