/**
 * Satori 频道动作：channel.get / channel.list
 * （channel.create / update / delete / mute：QQ 不支持 → 501，见 registry）
 */
import { z } from "zod";
import type { SatoriApi } from "../api/satori-api.js";
import { toChannelById } from "../helper/index.js";
import type { Channel, List } from "../types/index.js";
import { BaseSatoriAction } from "./base-action.js";

/** 动作依赖（Pick<SatoriApi> 视图）。 */
export type ChannelActionDeps = Pick<
    SatoriApi,
    "groupApi" | "selfUin" | "resolvePeer" | "setChannelType" | "groupCache"
>;

/** channel.get 参数。 */
const channelGetSchema = z.object({
    channel_id: z.string(),
});

/** 获取频道（群聊 = 群号频道；私聊 = uin 频道）。 */
export class ChannelGetAction extends BaseSatoriAction<z.infer<typeof channelGetSchema>, Channel> {
    readonly name = "channel.get";
    readonly schema = channelGetSchema;
    private readonly deps: ChannelActionDeps;

    constructor(deps: ChannelActionDeps) {
        super();
        this.deps = deps;
    }

    protected async _handle(payload: z.infer<typeof channelGetSchema>): Promise<Channel> {
        const { channel_id: channelId } = payload;
        const peer = await this.deps.resolvePeer(channelId);
        const isGroup = peer.chatType === 2;
        this.deps.setChannelType(channelId, isGroup);
        if (isGroup) {
            // 群聊频道：尝试补群名（缓存优先）
            const detail = await this.deps.groupCache?.getGroupDetail(channelId);
            return toChannelById(channelId, true, detail?.groupName);
        }
        return toChannelById(channelId, false);
    }
}

/** channel.list 参数。 */
const channelListSchema = z.object({
    guild_id: z.string(),
    next: z.string().optional(),
});

/** 获取群组频道列表（QQ：群组与群聊频道重合 → 单元素列表）。 */
export class ChannelListAction extends BaseSatoriAction<
    z.infer<typeof channelListSchema>,
    List<Channel>
> {
    readonly name = "channel.list";
    readonly schema = channelListSchema;
    private readonly deps: ChannelActionDeps;

    constructor(deps: ChannelActionDeps) {
        super();
        this.deps = deps;
    }

    protected async _handle(payload: z.infer<typeof channelListSchema>): Promise<List<Channel>> {
        const { guild_id: guildId } = payload;
        // 校验群存在（不存在抛 NOT_FOUND）
        const detail = await this.deps.groupCache?.getGroupDetail(guildId);
        const name = detail?.groupName;
        return {
            data: [toChannelById(guildId, true, name)],
        };
    }
}
