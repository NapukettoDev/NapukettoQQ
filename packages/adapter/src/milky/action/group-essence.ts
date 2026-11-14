/**
 * Milky 群精华与表态域动作（2026-11-14 自 group.ts 拆分，结构重构会话 4/5）
 *
 * - 精华：seq → msgId 经 seqIndex 反查；列表经 WebApi.getEssenceMsgList
 *   （kernel 无分页参数，客户端分页）。
 * - 表态：reaction_type face→"1" / emoji→"2"，对 msgSeq 所指消息表情表态。
 */
import type { EssenceMsgItem, Peer } from "@napuketto/kernel";
import { ChatType, kernelError } from "@napuketto/kernel";
import { z } from "zod";
import type {
    GetGroupEssenceMessagesOutput,
    GroupEssenceMessage,
    IncomingSegment,
} from "../types.js";
import { MilkyApiAction } from "./base-action.js";

const groupIdField = { group_id: z.number().int().min(10001) } as const;
const optBool = z.boolean().nullable().optional();

/**
 * get_group_essence_messages：获取精华消息列表。
 * WebApi.getEssenceMsgList 全量拉取后按 page_index/page_size 客户端分页
 * （kernel 无分页参数）；message_time 无源取 operation_time 兜底。
 */
export class GetGroupEssenceMessagesAction extends MilkyApiAction<
    { group_id: number; page_index: number; page_size: number },
    GetGroupEssenceMessagesOutput
> {
    readonly name = "get_group_essence_messages";
    readonly schema = z.object({
        ...groupIdField,
        page_index: z.number().int().min(0),
        page_size: z.number().int().min(0),
    });

    protected async _handle(payload: {
        group_id: number;
        page_index: number;
        page_size: number;
    }): Promise<GetGroupEssenceMessagesOutput> {
        const items = await this.api.webApi.getEssenceMsgList(String(payload.group_id));
        const start = payload.page_index * payload.page_size;
        const page = items.slice(start, start + payload.page_size);
        return {
            messages: page.map((item) => essenceToEntity(item, payload.group_id)),
            is_end: start + page.length >= items.length,
        };
    }
}

/** set_group_essence_message：设置/取消精华（seq → msgId 反查）。 */
export class SetGroupEssenceMessageAction extends MilkyApiAction<
    { group_id: number; message_seq: number; is_set?: boolean | null | undefined },
    Record<string, never>
> {
    readonly name = "set_group_essence_message";
    readonly schema = z.object({
        ...groupIdField,
        message_seq: z.number().int().min(0),
        is_set: optBool,
    });

    protected async _handle(payload: {
        group_id: number;
        message_seq: number;
        is_set?: boolean | null | undefined;
    }): Promise<Record<string, never>> {
        const groupCode = String(payload.group_id);
        const peer: Peer = { chatType: ChatType.GROUP, peerUid: groupCode };
        const msgId = await this.api.resolveMsgIdBySeq(peer, payload.message_seq, ChatType.GROUP);
        if (msgId === undefined) {
            throw kernelError(`消息 ${payload.message_seq} 不存在`, "NOT_FOUND");
        }
        if (payload.is_set === false) {
            await this.api.groupApi.removeGroupEssence(groupCode, msgId);
        } else {
            await this.api.groupApi.addGroupEssence(groupCode, msgId);
        }
        return {};
    }
}

/** send_group_message_reaction：消息表情表态（reaction_type face→"1" / emoji→"2"）。 */
export class SendGroupMessageReactionAction extends MilkyApiAction<
    {
        group_id: number;
        message_seq: number;
        reaction: string;
        reaction_type?: "face" | "emoji" | null | undefined;
        is_add?: boolean | null | undefined;
    },
    Record<string, never>
> {
    readonly name = "send_group_message_reaction";
    readonly schema = z.object({
        ...groupIdField,
        message_seq: z.number().int().min(0),
        reaction: z.string().min(1),
        reaction_type: z.enum(["face", "emoji"]).nullable().optional(),
        is_add: z.boolean().nullable().optional(),
    });

    protected async _handle(payload: {
        group_id: number;
        message_seq: number;
        reaction: string;
        reaction_type?: "face" | "emoji" | null | undefined;
        is_add?: boolean | null | undefined;
    }): Promise<Record<string, never>> {
        const peer: Peer = { chatType: ChatType.GROUP, peerUid: String(payload.group_id) };
        await this.api.msgApi.setMsgEmojiLike(peer, {
            msgSeq: String(payload.message_seq),
            emojiId: payload.reaction,
            emojiType: payload.reaction_type === "emoji" ? "2" : "1",
            like: payload.is_add !== false,
        });
        return {};
    }
}

/** ---------- 内部辅助 ---------- */

/** 精华项 → GroupEssenceMessage（msg_content 近似翻译：text / image）。 */
function essenceToEntity(item: EssenceMsgItem, groupId: number): GroupEssenceMessage {
    const segments: IncomingSegment[] = [];
    for (const c of item.msg_content) {
        if (c.text !== undefined && c.text !== "") {
            segments.push({ type: "text", data: { text: c.text } });
        } else if (c.image_url !== undefined && c.image_url !== "") {
            segments.push({
                type: "image",
                data: {
                    resource_id: c.image_url,
                    temp_url: c.image_url,
                    width: 0,
                    height: 0,
                    summary: "",
                    sub_type: "normal",
                },
            });
        }
    }
    return {
        group_id: groupId,
        message_seq: item.msg_seq,
        message_time: item.add_digest_time,
        sender_id: Number(item.sender_uin) || 0,
        sender_name: item.sender_nick,
        operator_id: Number(item.add_digest_uin) || 0,
        operator_name: item.add_digest_nick,
        operation_time: item.add_digest_time,
        segments,
    };
}
