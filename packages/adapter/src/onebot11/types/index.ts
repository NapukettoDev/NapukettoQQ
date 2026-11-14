/**
 * OneBot 11 类型定义（自研描述，参考公开协议规范）
 * 对应：接口签名是外部协议事实，可自研描述，不复制实现。
 */

/** OB11 统一返回结构。 */
export interface OB11Return<T> {
    status: "ok" | "failed";
    retcode: number;
    data: T;
    message: string;
    echo?: unknown;
}

/** OB11 消息段（segment）。 */
export type OB11MessageSegment =
    | { type: "text"; data: { text: string } }
    | { type: "at"; data: { qq: string; name?: string } }
    | { type: "face"; data: { id: string } }
    | { type: "image"; data: { file: string; url?: string } }
    | { type: "record"; data: { file: string; url?: string } }
    | { type: "video"; data: { file: string; url?: string } }
    | { type: "file"; data: { file: string } }
    | { type: "reply"; data: { id: string } }
    | { type: "forward"; data: { id: string } }
    | { type: "json"; data: { data: string } }
    | { type: "xml"; data: { data: string } }
    | { type: "string"; data: { text: string } };

/** OB11 消息（segment 数组或 CQ 码字符串）。 */
export type OB11Message = string | OB11MessageSegment[];

/** 消息发送来源。 */
export interface Sender {
    user_id: number;
    nickname?: string;
    card?: string;
    role?: "owner" | "admin" | "member";
}

/** 群信息（get_group_info 返回）。 */
export interface GroupInfo {
    group_id: number;
    group_name: string;
    member_count?: number;
    max_member_count?: number;
}

/** 登录信息（get_login_info 返回）。 */
export interface LoginInfo {
    user_id: number;
    nickname: string;
}

/** OB11 消息信息（get_msg / 历史消息返回项）。 */
export interface OB11MessageInfo {
    message_id: number;
    real_id?: number;
    message_type: "group" | "private";
    sender: {
        user_id: number;
        nickname: string;
        card?: string;
        role?: "owner" | "admin" | "member";
    };
    time: number;
    message: OB11MessageSegment[];
    raw_message: string;
    group_id?: number;
    user_id?: number;
}

/** 性别枚举。 */
export type Sex = "male" | "female" | "unknown";

/** 群成员信息（get_group_member_info 返回，含 go-cqhttp 扩展字段）。 */
export interface GroupMemberInfo {
    group_id: number;
    user_id: number;
    nickname: string;
    card?: string;
    sex?: Sex;
    age?: number;
    area?: string;
    join_time?: number;
    last_sent_time?: number;
    level?: string;
    role: "owner" | "admin" | "member";
    unfriendly?: boolean;
    title?: string;
    title_expire_time?: number;
    card_changeable?: boolean;
    /** go-cqhttp 扩展。 */
    qq_level?: number;
    group_level?: number;
    special_title?: string;
    shut_up_timestamp?: number;
    is_friend?: boolean;
    is_bot?: boolean;
}

/** 好友信息（get_friend_list 返回）。 */
export interface FriendInfo {
    user_id: number;
    nickname: string;
    remark?: string;
}

/** 陌生人信息（get_stranger_info 返回）。 */
export interface StrangerInfo {
    user_id: number;
    nickname: string;
    sex?: Sex;
    age?: number;
    /** go-cqhttp 扩展。 */
    qid?: string;
    level?: number;
    login_days?: number;
    uid?: string;
}

/** 群荣誉成员项（get_group_honor_info 返回列表项）。 */
export interface HonorMember {
    user_id: number;
    nickname: string;
    avatar?: string;
    day_count?: number;
    description?: string;
}

/** 当前龙王（可能为 null）。 */
export interface CurrentTalkative {
    user_id: number;
    nickname: string;
    day_count: number;
}

/** 群荣誉信息（get_group_honor_info 返回）。 */
export interface GroupHonorInfo {
    group_id: number;
    current_talkative?: CurrentTalkative | null;
    talkative_list: HonorMember[];
    performer_list: HonorMember[];
    legend_list: HonorMember[];
    strong_newbie_list: HonorMember[];
    emotion_list: HonorMember[];
}

/** 版本信息（get_version_info 返回，含 go-cqhttp 扩展字段）。 */
export interface VersionInfo {
    app_name: string;
    app_version: string;
    protocol_version: "v11";
    /** go-cqhttp 扩展。 */
    app_full_name?: string;
    runtime_version?: string;
    runtime_os?: string;
    sign_library?: Record<string, unknown>;
    configuration?: Record<string, unknown>;
    walle_version?: string;
}
