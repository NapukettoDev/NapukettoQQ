/**
 * Satori 用户动作：user.get / user.channel.create
 */
import { z } from "zod";
import type { SatoriApi } from "../api/satori-api.js";
import { toChannelById, toUser } from "../helper/index.js";
import type { Channel, User } from "../types/index.js";
import { defineSatoriAction, type SatoriAction } from "./base-action.js";

/** 动作依赖（Pick<SatoriApi> 视图）。 */
export type UserActionDeps = Pick<SatoriApi, "profileApi" | "groupApi" | "groupCache">;

/** 用户动作工厂（user.get / user.channel.create）。 */
export function createUserActions(deps: UserActionDeps): SatoriAction[] {
    return [
        defineSatoriAction({
            name: "user.get",
            schema: z.object({ user_id: z.string() }),
            // QQ 平台 user.id = uin；尝试陌生人信息补昵称（失败退化为基础 User）
            handle: async (payload): Promise<User> => {
                const { user_id: userId } = payload;
                let nickname: string | undefined;
                try {
                    const info = await deps.profileApi.getStrangerInfo(userId);
                    nickname = info.nickname ?? info.long_nick ?? undefined;
                } catch {
                    // 陌生人信息不可用（非好友等）：仅 ID
                }
                return toUser(userId, nickname);
            },
        }),
        defineSatoriAction({
            name: "user.channel.create",
            schema: z.object({
                user_id: z.string(),
                guild_id: z.string().optional(),
            }),
            // 创建私聊频道（QQ：私聊频道 id = 对端 uin，无需实际创建）
            handle: async (payload): Promise<Channel> => {
                const { user_id: userId } = payload;
                // 私聊频道 id = 对端 uin（与消息事件/消息动作的私聊频道一致）
                return toChannelById(userId, false);
            },
        }),
    ];
}
