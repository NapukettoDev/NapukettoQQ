/**
 * 消息转发域动作
 *
 * - send_group_forward_msg / send_private_forward_msg：messages 每项为
 *   node 元素 `{ type: "node", data: { id } }`——id 是此前 send_msg 返回的 OB11
 *   message_id。经 MessageUnique 反查源 msgId + peer，组装到目标 peer（群直通 /
 *   私聊 uinToUid）→ MsgApi.sendForwardMessage
 * - forward_group_single_msg / forward_friend_single_msg：message_id 反查
 *   源 msgId + peer；group_id/user_id 为目标 → MsgApi.forwardSingleMessage
 * - get_forward_msg：message_id / id → fetchForwardMessage（getMultiMsg）
 *   → 每条 toOb11MessageInfo → { messages }
 */

import { ChatType, kernelError, type Peer } from "@napuketto/kernel";
import { z } from "zod";
import type { OneBotApi } from "../../api/one-bot-api.js";
import { toOb11MessageInfo } from "../../helper/index.js";
import { type MessageUnique, resolveMsgIdAndPeer } from "../../helper/message-unique.js";
import { defineOb11Action, type Ob11Action, resolveUid } from "../base-action.js";
import { MAX_FORWARD_NODES } from "../limits.js";
import { resolveTargetPeer } from "./resolve-peer.js";

const forwardNodeSchema = z.object({
    type: z.literal("node").optional(),
    data: z
        .object({
            id: z.union([z.number(), z.string()]),
        })
        .optional(),
});

const sendGroupForwardMsgSchema = z.object({
    group_id: z.number(),
    // 上界见 action/limits.ts
    messages: z.array(z.unknown()).max(MAX_FORWARD_NODES).default([]),
});

const sendPrivateForwardMsgSchema = z.object({
    user_id: z.number(),
    // 上界见 action/limits.ts
    messages: z.array(z.unknown()).max(MAX_FORWARD_NODES).default([]),
});

const forwardSingleMsgSchema = z.object({
    message_id: z.union([z.number(), z.string()]),
    group_id: z.number().optional(),
    user_id: z.number().optional(),
});

type ForwardSingleMsgPayload = z.infer<typeof forwardSingleMsgSchema>;

const getForwardMsgSchema = z.object({
    message_id: z.union([z.number(), z.string()]).optional(),
    id: z.union([z.number(), z.string()]).optional(),
});

/** 合并转发依赖（OneBotApi 视图，由装配方注入）。 */
type ForwardMsgDeps = Pick<OneBotApi, "msgApi" | "messageUnique" | "uinToUid">;

/** 解析 node 元素列表 → 源消息 (msgId, peer) 列表（id 反查，跳过无法解析的项）。 */
function resolveSourceMessages(
    messages: unknown[],
    unique: MessageUnique,
): Array<{ msgId: string; peer: Peer }> {
    const out: Array<{ msgId: string; peer: Peer }> = [];
    for (const raw of messages) {
        const parsed = forwardNodeSchema.safeParse(raw);
        if (parsed.success) {
            const id = parsed.data.data?.id;
            if (id !== undefined) {
                const msgId = unique.getMsgId(Number(id));
                if (msgId !== undefined) {
                    const peer = unique.getPeer(msgId);
                    if (peer !== undefined) {
                        out.push({ msgId, peer });
                    }
                }
            }
        }
    }
    return out;
}

/** 合并转发发送（群/私聊共用：解析源消息 → 发送 → 映射 message_id）。 */
async function sendForward(
    messages: unknown[],
    target: Peer,
    deps: ForwardMsgDeps,
): Promise<{ message_id: number }> {
    const sources = resolveSourceMessages(messages, deps.messageUnique);
    const [firstSource] = sources;
    if (firstSource === undefined) {
        throw kernelError("合并转发需要至少一条可解析的源消息（node.id）", "INVALID_PARAM");
    }
    const { msgId } = await deps.msgApi.sendForwardMessage(
        target,
        firstSource.peer,
        sources.map((s) => s.msgId),
    );
    return { message_id: deps.messageUnique.alloc(msgId, target) };
}

/** 单条转发共用实现：message_id 反查源消息 + 目标 Peer 解析 → forwardSingleMessage。 */
async function forwardSingleMsg(
    payload: ForwardSingleMsgPayload,
    deps: ForwardMsgDeps,
): Promise<null> {
    const { msgId, peer: sourcePeer } = resolveMsgIdAndPeer(payload.message_id, deps.messageUnique);
    const dstPeer = await resolveTargetPeer(payload, deps, "单条转发需要 group_id 或 user_id");
    await deps.msgApi.forwardSingleMessage(sourcePeer, [msgId], dstPeer);
    return null;
}

/** 消息转发域动作工厂（合并转发 ×2 / get_forward_msg / 单条转发 ×2）。 */
export function createForwardActions(api: OneBotApi): Ob11Action[] {
    return [
        defineOb11Action({
            name: "send_group_forward_msg",
            schema: sendGroupForwardMsgSchema,
            handle: async (payload) => {
                const target: Peer = {
                    chatType: ChatType.GROUP,
                    peerUid: String(payload.group_id),
                };
                return await sendForward(payload.messages, target, api);
            },
        }),
        defineOb11Action({
            name: "send_private_forward_msg",
            schema: sendPrivateForwardMsgSchema,
            handle: async (payload) => {
                const uid = await resolveUid(String(payload.user_id), api.uinToUid);
                const target: Peer = { chatType: ChatType.C2C, peerUid: uid };
                return await sendForward(payload.messages, target, api);
            },
        }),
        defineOb11Action({
            name: "get_forward_msg",
            schema: getForwardMsgSchema,
            handle: async (payload) => {
                const id = payload.message_id ?? payload.id;
                if (id === undefined) {
                    throw kernelError("get_forward_msg 需要 message_id 或 id", "INVALID_PARAM");
                }
                const { msgId, peer } = resolveMsgIdAndPeer(id, api.messageUnique);
                const msgs = await api.msgApi.fetchForwardMessage(peer, msgId);
                return {
                    messages: msgs.map((msg) => toOb11MessageInfo(msg, api.messageUnique)),
                };
            },
        }),
        defineOb11Action({
            name: "forward_group_single_msg",
            schema: forwardSingleMsgSchema,
            handle: (payload) => forwardSingleMsg(payload, api),
        }),
        defineOb11Action({
            name: "forward_friend_single_msg",
            schema: forwardSingleMsgSchema,
            handle: (payload) => forwardSingleMsg(payload, api),
        }),
    ];
}
