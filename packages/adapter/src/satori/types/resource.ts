/**
 * Satori 资源类型（协议 v1，自研描述，规范参考 satori.chat/zh-CN/resources）
 *
 * 说明：Satori 大部分字段可选（平台差异）。QQ 平台（platform=qq）语义
 * 见 docs/protocols/satori.md §6 ID 映射。
 */

/** 频道类型。 */
export const ChannelType = {
    TEXT: 0, // 文本频道
    DIRECT: 1, // 私聊频道
    CATEGORY: 2, // 分类频道
    VOICE: 3, // 语音频道
} as const;
export type ChannelType = (typeof ChannelType)[keyof typeof ChannelType];

/** 登录状态。 */
export const LoginStatus = {
    OFFLINE: 0, // 离线
    ONLINE: 1, // 在线
    CONNECT: 2, // 正在连接
    DISCONNECT: 3, // 正在断开连接
    RECONNECT: 4, // 正在重新连接
} as const;
export type LoginStatus = (typeof LoginStatus)[keyof typeof LoginStatus];

/** 用户（user.id 为平台内唯一标识；QQ 平台 = uin）。 */
export interface User {
    id: string;
    name?: string;
    nick?: string;
    avatar?: string;
    is_bot?: boolean;
}

/** 频道（群聊频道与群组重合：id = 群号；私聊频道 id = 对端 uin）。 */
export interface Channel {
    id: string;
    type: ChannelType;
    name?: string;
    parent_id?: string;
}

/** 群组（id = 群号）。 */
export interface Guild {
    id: string;
    name?: string;
    avatar?: string;
}

/** 群组成员。 */
export interface GuildMember {
    user?: User;
    nick?: string;
    avatar?: string;
    joined_at?: number;
    roles?: GuildRole[];
}

/** 群组角色。 */
export interface GuildRole {
    id: string;
    name?: string;
}

/** 好友。 */
export interface Friend {
    user?: User;
    nick?: string;
}

/** 表情。 */
export interface Emoji {
    id: string;
    name?: string;
}

/** 登录信息（非登录事件中 login 只带 sn/user/platform）。 */
export interface Login {
    /** 序列号（仅标识 Login 对象，非持久化，与 login.user.id 区分）。 */
    sn: number;
    /** 平台名称（qq）。 */
    platform?: string;
    /** 平台用户（机器人身份）。 */
    user?: User;
    /** 登录状态。 */
    status: LoginStatus;
    /** 适配器名称（napuketto）。 */
    adapter: string;
    /** 平台特性列表（features 判断 API 可用性）。 */
    features?: string[];
}

/** 消息（content 为 Satori 元素字符串；资源提升后不含 user/member/channel）。 */
export interface Message {
    id: string;
    content?: string;
    channel?: Channel;
    guild?: Guild;
    member?: GuildMember;
    user?: User;
    created_at?: number;
    updated_at?: number;
}
