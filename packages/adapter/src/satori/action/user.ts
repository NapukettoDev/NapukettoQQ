/**
 * Satori 用户动作：user.get / user.channel.create
 */
import { z } from "zod";
import type { SatoriApi } from "../api/satori-api.js";
import { toChannelById, toUser } from "../helper/index.js";
import type { Channel, User } from "../types/index.js";
import { BaseSatoriAction } from "./base-action.js";

/** 动作依赖（Pick<SatoriApi> 视图）。 */
export type UserActionDeps = Pick<SatoriApi, "profileApi" | "groupApi" | "groupCache">;

/** user.get 参数。 */
const userGetSchema = z.object({
    user_id: z.string(),
});

/** 获取用户信息（QQ 平台 user.id = uin）。 */
export class UserGetAction extends BaseSatoriAction<z.infer<typeof userGetSchema>, User> {
    readonly name = "user.get";
    readonly schema = userGetSchema;
    private readonly deps: UserActionDeps;

    constructor(deps: UserActionDeps) {
        super();
        this.deps = deps;
    }

    protected async _handle(payload: z.infer<typeof userGetSchema>): Promise<User> {
        const { user_id: userId } = payload;
        // 尝试陌生人信息补昵称（失败退化为基础 User）
        let nickname: string | undefined;
        try {
            const info = await this.deps.profileApi.getStrangerInfo(userId);
            nickname = info.nickname ?? info.long_nick ?? undefined;
        } catch {
            // 陌生人信息不可用（非好友等）：仅 ID
        }
        return toUser(userId, nickname);
    }
}

/** user.channel.create 参数。 */
const userChannelCreateSchema = z.object({
    user_id: z.string(),
    guild_id: z.string().optional(),
});

/** 创建私聊频道（QQ：私聊频道 id = 对端 uin，无需实际创建）。 */
export class UserChannelCreateAction extends BaseSatoriAction<
    z.infer<typeof userChannelCreateSchema>,
    Channel
> {
    readonly name = "user.channel.create";
    readonly schema = userChannelCreateSchema;

    protected async _handle(payload: z.infer<typeof userChannelCreateSchema>): Promise<Channel> {
        const { user_id: userId } = payload;
        // 私聊频道 id = 对端 uin（与消息事件/消息动作的私聊频道一致）
        return toChannelById(userId, false);
    }
}
