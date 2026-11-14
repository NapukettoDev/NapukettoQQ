/**
 * 消息操作域动作
 *
 * - delete_msg：撤回消息（OB11 标准只有 message_id，peer 经 MessageUnique 反查；
 *   群聊管理员 / 私聊 2 分钟内可撤回）
 * - mark_msg_as_read：OB11 标准以 user_id 为参数，NapCat 扩展同时支持 group_id；
 *   mark_private_msg_as_read / mark_group_msg_as_read 为细分同名动作
 * - set_msg_emoji_like：message_id → 拉消息取 msgSeq → MsgApi.setMsgEmojiLike
 * - set_input_status：user_id → uinToUid → MsgApi.setInputStatus（1=输入中，0=停止）
 */

import { ChatType } from "@napuketto/kernel";
import { z } from "zod";
import type { OneBotApi } from "../../api/one-bot-api.js";
import { resolveMsgIdAndPeer } from "../../helper/message-unique.js";
import { defineOb11Action, type Ob11Action, resolveUid } from "../base-action.js";
import { fetchMsgById } from "./resolve-peer.js";

const deleteMsgSchema = z.object({
    message_id: z.union([z.number(), z.string()]),
});

const markMsgAsReadSchema = z
    .object({
        user_id: z.number().optional(),
        group_id: z.number().optional(),
    })
    .refine((v) => v.user_id !== undefined || v.group_id !== undefined, {
        message: "mark_msg_as_read 需要 user_id 或 group_id",
    });

const markPrivateMsgAsReadSchema = z.object({
    user_id: z.number(),
});

const markGroupMsgAsReadSchema = z.object({
    group_id: z.number(),
});

const setMsgEmojiLikeSchema = z.object({
    message_id: z.union([z.number(), z.string()]),
    /** 表情 ID（如 105 点赞）。 */
    emoji_id: z.number(),
    /** 表情类型（默认 1）。 */
    emoji_type: z.number().optional(),
    /** 是否点赞（false 取消）。 */
    like: z.boolean().optional(),
});

const setInputStatusSchema = z.object({
    user_id: z.number(),
    /** 输入事件类型：1=输入中，0=停止。 */
    event_type: z.number().optional(),
});

/** 输入中事件类型。 */
const EVENT_TYPE_TYPING = 1;

/**
 * 消息操作域动作工厂（delete_msg / mark_msg_as_read 系列 / set_msg_emoji_like /
 * set_input_status）。
 */
export function createMsgOpsActions(api: OneBotApi): Ob11Action[] {
    return [
        defineOb11Action({
            name: "delete_msg",
            schema: deleteMsgSchema,
            handle: async (payload) => {
                const { msgId, peer } = resolveMsgIdAndPeer(payload.message_id, api.messageUnique);
                await api.msgApi.recallMessage(peer, [msgId]);
                return null;
            },
        }),
        defineOb11Action({
            name: "mark_msg_as_read",
            schema: markMsgAsReadSchema,
            handle: async (payload) => {
                if (payload.group_id !== undefined) {
                    await api.msgApi.markRead({
                        chatType: ChatType.GROUP,
                        peerUid: String(payload.group_id),
                    });
                    return null;
                }
                if (payload.user_id !== undefined) {
                    const uid = await resolveUid(String(payload.user_id), api.uinToUid);
                    await api.msgApi.markRead({ chatType: ChatType.C2C, peerUid: uid });
                }
                return null;
            },
        }),
        defineOb11Action({
            name: "mark_private_msg_as_read",
            schema: markPrivateMsgAsReadSchema,
            handle: async (payload) => {
                const uid = await resolveUid(String(payload.user_id), api.uinToUid);
                await api.msgApi.markRead({ chatType: ChatType.C2C, peerUid: uid });
                return null;
            },
        }),
        defineOb11Action({
            name: "mark_group_msg_as_read",
            schema: markGroupMsgAsReadSchema,
            handle: async (payload) => {
                await api.msgApi.markRead({
                    chatType: ChatType.GROUP,
                    peerUid: String(payload.group_id),
                });
                return null;
            },
        }),
        defineOb11Action({
            name: "set_msg_emoji_like",
            schema: setMsgEmojiLikeSchema,
            handle: async (payload) => {
                const { msg, peer } = await fetchMsgById(
                    payload.message_id,
                    api.messageUnique,
                    api.msgApi,
                );
                await api.msgApi.setMsgEmojiLike(peer, {
                    msgSeq: msg.msgSeq,
                    emojiId: String(payload.emoji_id),
                    emojiType: String(payload.emoji_type ?? 1),
                    like: payload.like ?? true,
                });
                return null;
            },
        }),
        defineOb11Action({
            name: "set_input_status",
            schema: setInputStatusSchema,
            handle: async (payload) => {
                const uid = await resolveUid(String(payload.user_id), api.uinToUid);
                await api.msgApi.setInputStatus(
                    { chatType: ChatType.C2C, peerUid: uid },
                    payload.event_type ?? EVENT_TYPE_TYPING,
                );
                return null;
            },
        }),
    ];
}
