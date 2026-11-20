/**
 * Satori 频道/登录 ID 构造（QQ 平台语义）
 *
 * - 群聊：guild.id = channel.id = 群号，channel.type = TEXT（guild.plain）
 * - 私聊：channel.id = 对端 uin，channel.type = DIRECT，无 guild
 * - user.id = uin；message.id = NT msgId
 * - login.user.id = 机器人 uin
 */

import type { Channel, Guild, Login, User } from "../types/index.js";
import { ChannelType } from "../types/index.js";

/** 平台名（固定 qq）。 */
export const PLATFORM = "qq";
/** 适配器名（固定 napuketto）。 */
export const ADAPTER = "napuketto";

/** 平台特性（API 可用性判断；群聊频道与群组重合 → guild.plain）。 */
export const FEATURES = [
    "guild.plain", // 群组内只能存在一个消息频道
    "message.list.from", // message.list 支持以消息 ID 作分页令牌
] as const;

/** 构造用户（uin）。name/nick 兼容 Linux 原生对象的显式 null。 */
export function toUser(id: string, name?: string | null, nick?: string | null): User {
    const user: User = { id };
    if (name != null && name !== "") {
        user.name = name;
    }
    if (nick != null && nick !== "") {
        user.nick = nick;
    }
    return user;
}

/** 构造群聊频道（id = 群号）。 */
export function toGroupChannel(groupCode: string, name?: string): Channel {
    const channel: Channel = { id: String(groupCode), type: ChannelType.TEXT };
    if (name !== undefined && name !== "") {
        channel.name = name;
    }
    return channel;
}

/** 构造私聊频道（id = 对端 uin）。 */
export function toDirectChannel(uin: string, name?: string): Channel {
    const channel: Channel = { id: String(uin), type: ChannelType.DIRECT };
    if (name !== undefined && name !== "") {
        channel.name = name;
    }
    return channel;
}

/** 构造群组（id = 群号）。 */
export function toGuild(groupCode: string, name?: string, avatar?: string): Guild {
    const guild: Guild = { id: String(groupCode) };
    if (name !== undefined && name !== "") {
        guild.name = name;
    }
    if (avatar !== undefined && avatar !== "") {
        guild.avatar = avatar;
    }
    return guild;
}

/** 构造登录信息（login.get / READY logins）。 */
export function toLogin(
    self: { uin: string; nickname: string },
    sn: number,
    online: boolean,
): Login {
    const login: Login = {
        sn,
        platform: PLATFORM,
        user: toUser(self.uin, self.nickname),
        status: online ? 1 : 0,
        adapter: ADAPTER,
        features: [...FEATURES],
    };
    return login;
}

/** 构造非登录事件的最小 login（只带 sn/user/platform，规范）。 */
export function toMinimalLogin(sn: number, selfUin: string): Login {
    return {
        sn,
        platform: PLATFORM,
        user: toUser(selfUin),
        status: 1,
        adapter: ADAPTER,
    };
}
