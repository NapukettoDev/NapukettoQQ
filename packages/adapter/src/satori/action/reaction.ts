/**
 * Satori 表态动作：reaction.create / reaction.delete
 * （reaction.clear / reaction.list：501，见 registry）
 */
import { z } from "zod";
import type { SatoriApi } from "../api/satori-api.js";
import { BaseSatoriAction } from "./base-action.js";

/** 动作依赖（Pick<SatoriApi> 视图）。 */
export type ReactionActionDeps = Pick<SatoriApi, "msgApi" | "resolvePeer">;

/** 表情 ID 默认类型（QQ 表情 id 为 qq 表情索引）。 */
const EMOJI_TYPE = "1";

/** reaction.create 参数。 */
const reactionCreateSchema = z.object({
    channel_id: z.string(),
    message_id: z.string(),
    emoji_id: z.string(),
});

/** 添加表态（QQ 表情表态，message_id = NT msgId）。 */
export class ReactionCreateAction extends BaseSatoriAction<
    z.infer<typeof reactionCreateSchema>,
    void
> {
    readonly name = "reaction.create";
    readonly schema = reactionCreateSchema;
    private readonly deps: ReactionActionDeps;

    constructor(deps: ReactionActionDeps) {
        super();
        this.deps = deps;
    }

    protected async _handle(payload: z.infer<typeof reactionCreateSchema>): Promise<void> {
        const { channel_id: channelId, message_id: messageId, emoji_id: emojiId } = payload;
        const peer = await this.deps.resolvePeer(channelId);
        await this.deps.msgApi.setMsgEmojiLike(peer, {
            msgSeq: messageId,
            emojiId,
            emojiType: EMOJI_TYPE,
            like: true,
        });
    }
}

/** reaction.delete 参数。 */
const reactionDeleteSchema = z.object({
    channel_id: z.string(),
    message_id: z.string(),
    emoji_id: z.string(),
    /** 删除指定用户的表态（缺省删除自己的）。 */
    user_id: z.string().optional(),
});

/** 删除表态（第一版仅支持删除自己的，与 QQ 表情表态能力对齐）。 */
export class ReactionDeleteAction extends BaseSatoriAction<
    z.infer<typeof reactionDeleteSchema>,
    void
> {
    readonly name = "reaction.delete";
    readonly schema = reactionDeleteSchema;
    private readonly deps: ReactionActionDeps;

    constructor(deps: ReactionActionDeps) {
        super();
        this.deps = deps;
    }

    protected async _handle(payload: z.infer<typeof reactionDeleteSchema>): Promise<void> {
        const {
            channel_id: channelId,
            message_id: messageId,
            emoji_id: emojiId,
            user_id: userId,
        } = payload;
        if (userId !== undefined) {
            throw new Error("暂不支持删除他人表态");
        }
        const peer = await this.deps.resolvePeer(channelId);
        await this.deps.msgApi.setMsgEmojiLike(peer, {
            msgSeq: messageId,
            emojiId,
            emojiType: EMOJI_TYPE,
            like: false,
        });
    }
}
