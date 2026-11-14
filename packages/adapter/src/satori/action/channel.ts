/**
 * Satori 频道动作：channel.get / channel.list
 * （channel.create / update / delete / mute：QQ 不支持 → 501，见 registry）
 */
import { z } from "zod";
import type { SatoriApi } from "../api/satori-api.js";
import { toChannelById } from "../helper/index.js";
import type { Channel, List } from "../types/index.js";
import { defineSatoriAction, type SatoriAction } from "./base-action.js";

/** 动作依赖（Pick<SatoriApi> 视图）。 */
export type ChannelActionDeps = Pick<
    SatoriApi,
    "groupApi" | "selfUin" | "resolvePeer" | "setChannelType" | "groupCache"
>;

/** 频道动作工厂（channel.get / channel.list）。 */
export function createChannelActions(deps: ChannelActionDeps): SatoriAction[] {
    return [
        defineSatoriAction({
            name: "channel.get",
            schema: z.object({ channel_id: z.string() }),
            // 获取频道（群聊 = 群号频道；私聊 = uin 频道）
            handle: async (payload): Promise<Channel> => {
                const { channel_id: channelId } = payload;
                const peer = await deps.resolvePeer(channelId);
                const isGroup = peer.chatType === 2;
                deps.setChannelType(channelId, isGroup);
                if (isGroup) {
                    // 群聊频道：尝试补群名（缓存优先）
                    const detail = await deps.groupCache?.getGroupDetail(channelId);
                    return toChannelById(channelId, true, detail?.groupName);
                }
                return toChannelById(channelId, false);
            },
        }),
        defineSatoriAction({
            name: "channel.list",
            schema: z.object({
                guild_id: z.string(),
                next: z.string().optional(),
            }),
            // 获取群组频道列表（QQ：群组与群聊频道重合 → 单元素列表）
            handle: async (payload): Promise<List<Channel>> => {
                const { guild_id: guildId } = payload;
                // 校验群存在（不存在抛 NOT_FOUND）
                const detail = await deps.groupCache?.getGroupDetail(guildId);
                const name = detail?.groupName;
                return {
                    data: [toChannelById(guildId, true, name)],
                };
            },
        }),
    ];
}
