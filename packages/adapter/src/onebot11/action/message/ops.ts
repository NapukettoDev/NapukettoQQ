/**
 * 消息操作域动作（2026-11-14 自 delete-msg / mark-msg-as-read(-aliases) /
 * set-msg-emoji-like / set-input-status 合并）
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
import { BaseAction } from "../../../core/index.js";
import type { OneBotApi } from "../../api/one-bot-api.js";
import { resolveMsgIdAndPeer } from "../../helper/message-unique.js";
import { ob11ErrorCodeMap } from "../error-map.js";
import { resolveUid } from "../resolve-uid.js";
import { fetchMsgById } from "./resolve-peer.js";

const deleteMsgSchema = z.object({
    message_id: z.union([z.number(), z.string()]),
});

type DeleteMsgPayload = z.infer<typeof deleteMsgSchema>;

/** 撤回消息依赖（OneBotApi 视图，由装配方注入）。 */
export type DeleteMsgDeps = Pick<OneBotApi, "msgApi" | "messageUnique">;

/** 撤回消息（P2-10 接 kernel recallMessage）。 */
export class DeleteMsgAction extends BaseAction<DeleteMsgPayload, null> {
    readonly name = "delete_msg";
    readonly schema = deleteMsgSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly deps: DeleteMsgDeps;

    constructor(deps: DeleteMsgDeps) {
        super();
        this.deps = deps;
    }

    protected async _handle(payload: DeleteMsgPayload): Promise<null> {
        const { msgId, peer } = resolveMsgIdAndPeer(payload.message_id, this.deps.messageUnique);
        await this.deps.msgApi.recallMessage(peer, [msgId]);
        return null;
    }
}

const markMsgAsReadSchema = z
    .object({
        user_id: z.number().optional(),
        group_id: z.number().optional(),
    })
    .refine((v) => v.user_id !== undefined || v.group_id !== undefined, {
        message: "mark_msg_as_read 需要 user_id 或 group_id",
    });

type MarkMsgAsReadPayload = z.infer<typeof markMsgAsReadSchema>;

/** 标记已读依赖（OneBotApi 视图，由装配方注入）。 */
export type MarkReadDeps = Pick<OneBotApi, "msgApi" | "uinToUid">;

/** 标记消息已读（P2-10 接 kernel markRead）。 */
export class MarkMsgAsReadAction extends BaseAction<MarkMsgAsReadPayload, null> {
    readonly name = "mark_msg_as_read";
    readonly schema = markMsgAsReadSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly deps: MarkReadDeps;

    constructor(deps: MarkReadDeps) {
        super();
        this.deps = deps;
    }

    protected async _handle(payload: MarkMsgAsReadPayload): Promise<null> {
        if (payload.group_id !== undefined) {
            await this.deps.msgApi.markRead({
                chatType: ChatType.GROUP,
                peerUid: String(payload.group_id),
            });
            return null;
        }
        if (payload.user_id !== undefined) {
            const uid = await resolveUid(String(payload.user_id), this.deps.uinToUid);
            await this.deps.msgApi.markRead({ chatType: ChatType.C2C, peerUid: uid });
        }
        return null;
    }
}

const markPrivateMsgAsReadSchema = z.object({
    user_id: z.number(),
});

type MarkPrivateMsgAsReadPayload = z.infer<typeof markPrivateMsgAsReadSchema>;

const markGroupMsgAsReadSchema = z.object({
    group_id: z.number(),
});

type MarkGroupMsgAsReadPayload = z.infer<typeof markGroupMsgAsReadSchema>;

/** 标记已读依赖（msgApi + uinToUid，OneBotApi 视图）。 */
export type MarkReadAliasDeps = Pick<OneBotApi, "msgApi" | "uinToUid">;

/** 标记私聊已读（P2-13）。 */
export class MarkPrivateMsgAsReadAction extends BaseAction<MarkPrivateMsgAsReadPayload, null> {
    readonly name = "mark_private_msg_as_read";
    readonly schema = markPrivateMsgAsReadSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly deps: MarkReadAliasDeps;

    constructor(deps: MarkReadAliasDeps) {
        super();
        this.deps = deps;
    }

    protected async _handle(payload: MarkPrivateMsgAsReadPayload): Promise<null> {
        const uid = await resolveUid(String(payload.user_id), this.deps.uinToUid);
        await this.deps.msgApi.markRead({ chatType: ChatType.C2C, peerUid: uid });
        return null;
    }
}

/** 标记群聊已读（P2-13）。 */
export class MarkGroupMsgAsReadAction extends BaseAction<MarkGroupMsgAsReadPayload, null> {
    readonly name = "mark_group_msg_as_read";
    readonly schema = markGroupMsgAsReadSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly deps: Pick<OneBotApi, "msgApi">;

    constructor(deps: Pick<OneBotApi, "msgApi">) {
        super();
        this.deps = deps;
    }

    protected async _handle(payload: MarkGroupMsgAsReadPayload): Promise<null> {
        await this.deps.msgApi.markRead({
            chatType: ChatType.GROUP,
            peerUid: String(payload.group_id),
        });
        return null;
    }
}

const setMsgEmojiLikeSchema = z.object({
    message_id: z.union([z.number(), z.string()]),
    /** 表情 ID（如 105 点赞）。 */
    emoji_id: z.number(),
    /** 表情类型（默认 1）。 */
    emoji_type: z.number().optional(),
    /** 是否点赞（false 取消）。 */
    like: z.boolean().optional(),
});

type SetMsgEmojiLikePayload = z.infer<typeof setMsgEmojiLikeSchema>;

/** 表情表态依赖（OneBotApi 视图，由装配方注入）。 */
export type SetMsgEmojiLikeDeps = Pick<OneBotApi, "msgApi" | "messageUnique">;

/** 消息表情表态（P2-10 接 kernel setMsgEmojiLike）。 */
export class SetMsgEmojiLikeAction extends BaseAction<SetMsgEmojiLikePayload, null> {
    readonly name = "set_msg_emoji_like";
    readonly schema = setMsgEmojiLikeSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly deps: SetMsgEmojiLikeDeps;

    constructor(deps: SetMsgEmojiLikeDeps) {
        super();
        this.deps = deps;
    }

    protected async _handle(payload: SetMsgEmojiLikePayload): Promise<null> {
        const { msg, peer } = await fetchMsgById(
            payload.message_id,
            this.deps.messageUnique,
            this.deps.msgApi,
        );
        await this.deps.msgApi.setMsgEmojiLike(peer, {
            msgSeq: msg.msgSeq,
            emojiId: String(payload.emoji_id),
            emojiType: String(payload.emoji_type ?? 1),
            like: payload.like ?? true,
        });
        return null;
    }
}

const setInputStatusSchema = z.object({
    user_id: z.number(),
    /** 输入事件类型：1=输入中，0=停止。 */
    event_type: z.number().optional(),
});

type SetInputStatusPayload = z.infer<typeof setInputStatusSchema>;

/** 输入中事件类型。 */
const EVENT_TYPE_TYPING = 1;

/** set_input_status 依赖（OneBotApi 视图）。 */
export type SetInputStatusDeps = Pick<OneBotApi, "msgApi" | "uinToUid">;

/** 发送输入状态（P2-11 接 kernel setInputStatus）。 */
export class SetInputStatusAction extends BaseAction<SetInputStatusPayload, null> {
    readonly name = "set_input_status";
    readonly schema = setInputStatusSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly deps: SetInputStatusDeps;

    constructor(deps: SetInputStatusDeps) {
        super();
        this.deps = deps;
    }

    protected async _handle(payload: SetInputStatusPayload): Promise<null> {
        const uid = await resolveUid(String(payload.user_id), this.deps.uinToUid);
        await this.deps.msgApi.setInputStatus(
            { chatType: ChatType.C2C, peerUid: uid },
            payload.event_type ?? EVENT_TYPE_TYPING,
        );
        return null;
    }
}

/**
 * 消息操作域动作工厂（delete_msg / mark_msg_as_read 系列 / set_msg_emoji_like /
 * set_input_status）。
 */
export function createMsgOpsActions(api: OneBotApi): BaseAction<unknown, unknown>[] {
    return [
        new DeleteMsgAction(api),
        new MarkMsgAsReadAction(api),
        new MarkPrivateMsgAsReadAction(api),
        new MarkGroupMsgAsReadAction(api),
        new SetMsgEmojiLikeAction(api),
        new SetInputStatusAction(api),
    ];
}
