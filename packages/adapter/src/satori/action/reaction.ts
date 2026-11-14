/**
 * Satori 表态动作：reaction.create / reaction.delete
 * （reaction.clear / reaction.list：501，见 registry）
 */
import { z } from "zod";
import type { SatoriApi } from "../api/satori-api.js";
import { defineSatoriAction, type SatoriAction } from "./base-action.js";

/** 动作依赖（Pick<SatoriApi> 视图）。 */
export type ReactionActionDeps = Pick<SatoriApi, "msgApi" | "resolvePeer">;

/** 表情 ID 默认类型（QQ 表情 id 为 qq 表情索引）。 */
const EMOJI_TYPE = "1";

/** 表态动作工厂（reaction.create / reaction.delete）。 */
export function createReactionActions(deps: ReactionActionDeps): SatoriAction[] {
    return [
        defineSatoriAction({
            name: "reaction.create",
            schema: z.object({
                channel_id: z.string(),
                message_id: z.string(),
                emoji_id: z.string(),
            }),
            // 添加表态（QQ 表情表态，message_id = NT msgId）
            handle: async (payload): Promise<void> => {
                const { channel_id: channelId, message_id: messageId, emoji_id: emojiId } = payload;
                const peer = await deps.resolvePeer(channelId);
                await deps.msgApi.setMsgEmojiLike(peer, {
                    msgSeq: messageId,
                    emojiId,
                    emojiType: EMOJI_TYPE,
                    like: true,
                });
            },
        }),
        defineSatoriAction({
            name: "reaction.delete",
            schema: z.object({
                channel_id: z.string(),
                message_id: z.string(),
                emoji_id: z.string(),
                /** 删除指定用户的表态（缺省删除自己的）。 */
                user_id: z.string().optional(),
            }),
            // 第一版仅支持删除自己的，与 QQ 表情表态能力对齐
            handle: async (payload): Promise<void> => {
                const {
                    channel_id: channelId,
                    message_id: messageId,
                    emoji_id: emojiId,
                    user_id: userId,
                } = payload;
                if (userId !== undefined) {
                    throw new Error("暂不支持删除他人表态");
                }
                const peer = await deps.resolvePeer(channelId);
                await deps.msgApi.setMsgEmojiLike(peer, {
                    msgSeq: messageId,
                    emojiId,
                    emojiType: EMOJI_TYPE,
                    like: false,
                });
            },
        }),
    ];
}
