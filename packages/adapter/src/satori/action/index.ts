/**
 * Satori 动作注册表（ADR-013 延伸）：动作依赖收敛为 { api: SatoriApi } 单聚合对象。
 *
 * 501 动作：规范「平台支持但适配器未实现 → 501」——QQ 平台不支持的
 * 能力（消息编辑/频道管理/角色管理等）统一注册 NotImplementedAction。
 */

import { ActionRegistry } from "../../core/framework/action-registry.js";
import type { SatoriApi } from "../api/satori-api.js";
import type { BaseSatoriAction } from "./base-action.js";
import { type ChannelActionDeps, ChannelGetAction, ChannelListAction } from "./channel.js";
import {
    type FriendActionDeps,
    FriendApproveAction,
    FriendDeleteAction,
    FriendListAction,
} from "./friend.js";
import {
    type GuildActionDeps,
    GuildApproveAction,
    GuildGetAction,
    GuildListAction,
    GuildMemberApproveAction,
    GuildMemberGetAction,
    GuildMemberKickAction,
    GuildMemberListAction,
    GuildMemberMuteAction,
} from "./guild.js";
import { type LoginActionDeps, LoginGetAction } from "./login.js";
import {
    type MessageActionDeps,
    MessageCreateAction,
    MessageDeleteAction,
    MessageGetAction,
    MessageListAction,
} from "./message.js";
import { NotImplementedAction } from "./not-implemented.js";
import { type ReactionActionDeps, ReactionCreateAction, ReactionDeleteAction } from "./reaction.js";
import type { UserActionDeps } from "./user.js";
import { UserChannelCreateAction, UserGetAction } from "./user.js";

/** 动作注册依赖（单聚合对象）。 */
export interface SatoriActionDeps {
    api: SatoriApi;
}

/** QQ 平台不支持的 Satori 标准动作（501）。 */
const NOT_IMPLEMENTED = [
    "message.update", // QQ 不支持编辑消息
    "channel.create", // QQ 不支持创建频道
    "channel.update",
    "channel.delete",
    "channel.mute",
    "guild.member.role.set",
    "guild.member.role.unset",
    "guild.role.list",
    "guild.role.create",
    "guild.role.update",
    "guild.role.delete",
    "reaction.clear",
    "reaction.list",
] as const;

/** Satori 动作注册表（core 泛型注册表按 BaseSatoriAction 实例化）。 */
export type SatoriActionRegistry = ActionRegistry<BaseSatoriAction<unknown, unknown>>;

/** 创建 Satori 动作注册表。 */
export function createSatoriActionRegistry(deps: SatoriActionDeps): SatoriActionRegistry {
    const registry = new ActionRegistry<BaseSatoriAction<unknown, unknown>>();
    const { api } = deps;

    const messageDeps: MessageActionDeps = api;
    registry.register(new MessageCreateAction(messageDeps));
    registry.register(new MessageGetAction(messageDeps));
    registry.register(new MessageListAction(messageDeps));
    registry.register(new MessageDeleteAction(messageDeps));

    const channelDeps: ChannelActionDeps = api;
    registry.register(new ChannelGetAction(channelDeps));
    registry.register(new ChannelListAction(channelDeps));

    const userDeps: UserActionDeps = api;
    registry.register(new UserGetAction(userDeps));
    registry.register(new UserChannelCreateAction());

    const guildDeps: GuildActionDeps = api;
    registry.register(new GuildGetAction(guildDeps));
    registry.register(new GuildListAction(guildDeps));
    registry.register(new GuildApproveAction(guildDeps));
    registry.register(new GuildMemberGetAction(guildDeps));
    registry.register(new GuildMemberListAction(guildDeps));
    registry.register(new GuildMemberKickAction(guildDeps));
    registry.register(new GuildMemberMuteAction(guildDeps));
    registry.register(new GuildMemberApproveAction(guildDeps));

    const friendDeps: FriendActionDeps = api;
    registry.register(new FriendListAction(friendDeps));
    registry.register(new FriendDeleteAction(friendDeps));
    registry.register(new FriendApproveAction(friendDeps));

    const loginDeps: LoginActionDeps = api;
    registry.register(new LoginGetAction(loginDeps));

    const reactionDeps: ReactionActionDeps = api;
    registry.register(new ReactionCreateAction(reactionDeps));
    registry.register(new ReactionDeleteAction(reactionDeps));

    for (const name of NOT_IMPLEMENTED) {
        registry.register(new NotImplementedAction(name));
    }

    return registry;
}
