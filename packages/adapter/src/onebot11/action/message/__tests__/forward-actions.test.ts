/**
 * 合并转发/单条转发动作测试：send_group_forward_msg / send_private_forward_msg /
 * forward_group_single_msg / forward_friend_single_msg / get_forward_msg。
 *
 * 锁定行为：node 元素 id → MessageUnique 反查源消息（msgId+peer）、非法 node 跳过、
 * 无可解析源 → INVALID_PARAM、目标 Peer（群直通 / 私聊 uin→uid）、单条转发走
 * forwardSingleMessage、get_forward_msg 的 message_id/id 双参数与缺参报错。
 */
import { ChatType, type Peer, type RawMessage } from "@napuketto/kernel";
import { describe, expect, it, vi } from "vitest";
import { MessageUnique } from "../../../helper/message-unique.js";
import {
    ForwardFriendSingleMsgAction,
    ForwardGroupSingleMsgAction,
    GetForwardMsgAction,
    SendGroupForwardMsgAction,
    SendPrivateForwardMsgAction,
} from "../forward.js";

/** 构造转发依赖桩（真实 MessageUnique + 可控 sendForwardMessage / fetchForwardMessage）。 */
function makeDeps(options?: {
    uinMap?: Record<string, string>;
    forwardResult?: { msgId: string };
}) {
    const unique = new MessageUnique();
    const sendForwardMessage = vi.fn(
        async (_target: Peer, _source: Peer, _msgIds: string[]) =>
            options?.forwardResult ?? { msgId: "nt-fwd" },
    );
    const forwardSingleMessage = vi.fn(async () => undefined);
    const fetchForwardMessage = vi.fn(async () => [] as never[]);
    const uinToUid = vi.fn(async (uins: string[]) => {
        const table = options?.uinMap ?? { "90001": "u90001" };
        return new Map(uins.filter((u) => u in table).map((u) => [u, table[u] as string]));
    });
    return {
        unique,
        sendForwardMessage,
        forwardSingleMessage,
        fetchForwardMessage,
        uinToUid,
        deps: {
            msgApi: { sendForwardMessage, forwardSingleMessage, fetchForwardMessage } as never,
            messageUnique: unique,
            uinToUid,
        },
    };
}

describe("send_group_forward_msg", () => {
    it("node id 反查源消息 → sendForwardMessage(群目标, 首源 peer, msgIds)", async () => {
        const { deps, unique, sendForwardMessage } = makeDeps();
        const srcPeer = { chatType: ChatType.GROUP, peerUid: "808" };
        unique.alloc("nt-a", srcPeer);
        unique.alloc("nt-b", srcPeer);
        const action = new SendGroupForwardMsgAction(deps);
        const result = await action.handle({
            group_id: 909,
            messages: [
                { type: "node", data: { id: 1 } },
                { type: "node", data: { id: 2 } },
            ],
        });
        expect(result.retcode).toBe(0);
        expect(result.data?.message_id).toBe(3);
        expect(sendForwardMessage).toHaveBeenCalledWith(
            { chatType: ChatType.GROUP, peerUid: "909" },
            srcPeer,
            ["nt-a", "nt-b"],
        );
    });

    it("非法 node / 反查不到的 id / 无 id 字段 → 跳过不致命", async () => {
        const { deps, unique, sendForwardMessage } = makeDeps();
        unique.alloc("nt-a", { chatType: ChatType.GROUP, peerUid: "808" });
        const action = new SendGroupForwardMsgAction(deps);
        await action.handle({
            group_id: 909,
            messages: [
                { type: "node", data: { id: 1 } }, // 命中
                { type: "node" }, // 无 data.id → 跳过
                { type: "node", data: { id: 999 } }, // 反查不到 → 跳过
                { bogus: true }, // 非 node 形状 → 跳过
            ],
        });
        expect(sendForwardMessage).toHaveBeenCalledWith(
            { chatType: ChatType.GROUP, peerUid: "909" },
            { chatType: ChatType.GROUP, peerUid: "808" },
            ["nt-a"],
        );
    });

    it("非对象 node（parse 失败）与已登记但无 peer 的 id → 各自跳过", async () => {
        const { deps, unique, sendForwardMessage } = makeDeps();
        unique.alloc("nt-nopeer"); // 无 peer 登记
        const action = new SendGroupForwardMsgAction(deps);
        await action.handle({
            group_id: 909,
            messages: [
                42, // 非对象 → schema 解析失败 → 跳过
                { type: "node", data: { id: 1 } }, // 无 peer → 跳过
            ],
        });
        expect(sendForwardMessage).not.toHaveBeenCalled();
    });

    it("全部 node 不可解析 → retcode 105（INVALID_PARAM）", async () => {
        const { deps } = makeDeps();
        const action = new SendGroupForwardMsgAction(deps);
        const result = await action.handle({ group_id: 909, messages: [{ type: "node" }] });
        expect(result.retcode).toBe(105);
        expect(result.message).toContain("至少一条可解析的源消息");
    });

    it("messages 缺省 []（zod default）→ retcode 105", async () => {
        const { deps } = makeDeps();
        const action = new SendGroupForwardMsgAction(deps);
        const result = await action.handle({ group_id: 909 });
        expect(result.retcode).toBe(105);
    });
});

describe("send_private_forward_msg", () => {
    it("user_id uin→uid → 目标 Peer{C2C}", async () => {
        const { deps, unique, sendForwardMessage } = makeDeps();
        unique.alloc("nt-a", { chatType: ChatType.GROUP, peerUid: "808" });
        const action = new SendPrivateForwardMsgAction(deps);
        const result = await action.handle({
            user_id: 90001,
            messages: [{ type: "node", data: { id: 1 } }],
        });
        expect(result.retcode).toBe(0);
        expect(sendForwardMessage.mock.calls[0]?.[0]).toEqual({
            chatType: ChatType.C2C,
            peerUid: "u90001",
        });
    });

    it("user_id 解析失败 → retcode 105", async () => {
        const { deps } = makeDeps({ uinMap: {} });
        const action = new SendPrivateForwardMsgAction(deps);
        const result = await action.handle({ user_id: 11111, messages: [] });
        expect(result.retcode).toBe(105);
    });
});

describe("forward_group_single_msg / forward_friend_single_msg", () => {
    it("message_id 反查 + 群目标 → forwardSingleMessage(srcPeer, [msgId], dstPeer)", async () => {
        const { deps, unique, forwardSingleMessage } = makeDeps();
        const srcPeer = { chatType: ChatType.GROUP, peerUid: "808" };
        unique.alloc("nt-a", srcPeer);
        const action = new ForwardGroupSingleMsgAction(deps);
        const result = await action.handle({ message_id: 1, group_id: 909 });
        expect(result.retcode).toBe(0);
        expect(forwardSingleMessage).toHaveBeenCalledWith(srcPeer, ["nt-a"], {
            chatType: ChatType.GROUP,
            peerUid: "909",
        });
    });

    it("好友目标 → uin→uid 解析", async () => {
        const { deps, unique, forwardSingleMessage } = makeDeps();
        unique.alloc("nt-a", { chatType: ChatType.GROUP, peerUid: "808" });
        const action = new ForwardFriendSingleMsgAction(deps);
        const result = await action.handle({ message_id: 1, user_id: 90001 });
        expect(result.retcode).toBe(0);
        expect(forwardSingleMessage).toHaveBeenCalledWith(
            { chatType: ChatType.GROUP, peerUid: "808" },
            ["nt-a"],
            { chatType: ChatType.C2C, peerUid: "u90001" },
        );
    });

    it("message_id 未登记 → retcode 102；目标缺失 → retcode 105", async () => {
        const { deps } = makeDeps();
        const action = new ForwardGroupSingleMsgAction(deps);
        expect((await action.handle({ message_id: 999, group_id: 1 })).retcode).toBe(102);
        deps.messageUnique.alloc("nt-1", { chatType: ChatType.GROUP, peerUid: "808" });
        // 源消息已登记但既无 group_id 也无 user_id → 目标解析失败
        expect((await action.handle({ message_id: 1 })).retcode).toBe(105);
    });
});

describe("get_forward_msg", () => {
    it("message_id → fetchForwardMessage → 逐条 OB11 信息（空转发返回空数组）", async () => {
        const { deps, unique, fetchForwardMessage } = makeDeps();
        unique.alloc("nt-fwd", { chatType: ChatType.GROUP, peerUid: "808" });
        const action = new GetForwardMsgAction(deps);
        const result = await action.handle({ message_id: 1 });
        expect(result.status).toBe("ok");
        expect(fetchForwardMessage).toHaveBeenCalledWith(
            { chatType: ChatType.GROUP, peerUid: "808" },
            "nt-fwd",
        );
        expect(result.data?.messages).toEqual([]);
    });

    it("id 参数（NapCat 兼容别名）同样反查", async () => {
        const { deps, unique, fetchForwardMessage } = makeDeps();
        unique.alloc("nt-fwd", { chatType: ChatType.GROUP, peerUid: "808" });
        const action = new GetForwardMsgAction(deps);
        await action.handle({ id: "1" });
        expect(fetchForwardMessage).toHaveBeenCalledTimes(1);
    });

    it("fetchForwardMessage 返回消息 → 逐条翻译为 OB11 信息", async () => {
        const { deps, unique } = makeDeps();
        const inner: RawMessage = {
            msgId: "nt-inner",
            msgSeq: "3",
            msgTime: "1700000000000",
            chatType: ChatType.GROUP,
            peerUid: "808",
            peerUin: "808",
            senderUid: "u90001",
            senderUin: "90001",
            peerName: "群",
            sendNickName: "甲",
            elements: [{ elementType: 1, textElement: { content: "转发内文" } }],
        } as unknown as RawMessage;
        (
            deps.msgApi as {
                fetchForwardMessage: (peer: Peer, msgId: string) => Promise<RawMessage[]>;
            }
        ).fetchForwardMessage = vi.fn(async () => [inner]);
        unique.alloc("nt-fwd", { chatType: ChatType.GROUP, peerUid: "808" });
        const action = new GetForwardMsgAction(deps);
        const result = await action.handle({ message_id: 1 });
        expect(result.data?.messages).toHaveLength(1);
        expect(result.data?.messages[0]).toMatchObject({
            message_type: "group",
            group_id: 808,
            sender: { user_id: 90001, nickname: "甲" },
        });
    });

    it("缺 message_id 与 id → retcode 105", async () => {
        const { deps } = makeDeps();
        const action = new GetForwardMsgAction(deps);
        const result = await action.handle({});
        expect(result.retcode).toBe(105);
        expect(result.message).toBe("get_forward_msg 需要 message_id 或 id");
    });
});
