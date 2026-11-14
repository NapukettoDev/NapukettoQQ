/**
 * OneBot 11 通知事件（notice）
 *
 * 前 8 类为 OneBot 11 标准通知；notify / offline_file / group_essence 为 go-cqhttp 扩展；
 * group_sign / msg_emoji_like / group_title 为 NapCat 兼容扩展。字段为公开协议事实，自研描述。
 */

import type { OB11BaseEvent } from "./base.js";

/** 群文件信息（group_upload 的 file 字段）。 */
export interface GroupFileInfo {
    id: string;
    name: string;
    size: number;
    busid: number;
}

/** 离线文件信息（offline_file 的 file 字段）。 */
export interface OfflineFileInfo {
    name: string;
    size: number;
    url: string;
}

/** 消息表情回应项（msg_emoji_like 的 likes 项）。 */
export interface EmojiLikeItem {
    nickname: string;
    user_id: number;
    face_id: number;
}

/** 群文件上传（群成员上传了文件）。 */
export interface OB11GroupUploadNoticeEvent extends OB11BaseEvent {
    post_type: "notice";
    notice_type: "group_upload";
    group_id: number;
    user_id: number;
    file: GroupFileInfo;
}

/** 群管理员变更。 */
export interface OB11GroupAdminNoticeEvent extends OB11BaseEvent {
    post_type: "notice";
    notice_type: "group_admin";
    sub_type: "set" | "unset";
    group_id: number;
    user_id: number;
}

/** 群成员减少（主动退群 / 被踢 / 机器人被踢）。 */
export interface OB11GroupDecreaseNoticeEvent extends OB11BaseEvent {
    post_type: "notice";
    notice_type: "group_decrease";
    sub_type: "leave" | "kick" | "kick_me";
    group_id: number;
    operator_id: number;
    user_id: number;
}

/** 群成员增加（管理员同意入群 / 成员邀请入群）。 */
export interface OB11GroupIncreaseNoticeEvent extends OB11BaseEvent {
    post_type: "notice";
    notice_type: "group_increase";
    sub_type: "approve" | "invite";
    group_id: number;
    operator_id: number;
    user_id: number;
}

/** 群禁言（禁言 / 解除禁言）。 */
export interface OB11GroupBanNoticeEvent extends OB11BaseEvent {
    post_type: "notice";
    notice_type: "group_ban";
    sub_type: "ban" | "lift_ban";
    group_id: number;
    operator_id: number;
    user_id: number;
    /** 禁言时长（秒，0 表示解除禁言）。 */
    duration: number;
}

/** 好友添加。 */
export interface OB11FriendAddNoticeEvent extends OB11BaseEvent {
    post_type: "notice";
    notice_type: "friend_add";
    user_id: number;
}

/** 群消息撤回。 */
export interface OB11GroupRecallNoticeEvent extends OB11BaseEvent {
    post_type: "notice";
    notice_type: "group_recall";
    group_id: number;
    user_id: number;
    operator_id: number;
    message_id: number;
}

/** 好友消息撤回。 */
export interface OB11FriendRecallNoticeEvent extends OB11BaseEvent {
    post_type: "notice";
    notice_type: "friend_recall";
    user_id: number;
    message_id: number;
}

/** 群成员名片变更（go-cqhttp 扩展）。 */
export interface OB11GroupCardNoticeEvent extends OB11BaseEvent {
    post_type: "notice";
    notice_type: "group_card";
    group_id: number;
    user_id: number;
    card_new: string;
    card_old: string;
}

/**
 * 群消息精华（go-cqhttp 扩展；接线）。
 * sender_id = 被加精消息发送者（列表 sender_uin / prev 缓存回填）；
 * operator_id 仅 add 回填（add_digest_uin）——delete 无任何数据源，省略。
 */
export interface OB11GroupEssenceNoticeEvent extends OB11BaseEvent {
    post_type: "notice";
    notice_type: "group_essence";
    sub_type: "add" | "delete";
    group_id: number;
    sender_id: number;
    operator_id?: number;
    message_id: number;
}

/** 系统通知（go-cqhttp 扩展）：戳一戳 / 红包运气王 / 群荣誉。 */
export interface OB11NotifyNoticeEvent extends OB11BaseEvent {
    post_type: "notice";
    notice_type: "notify";
    sub_type: "poke" | "lucky_notify" | "honor";
    group_id: number;
    user_id: number;
    target_id: number;
    /** honor 子类型时的荣誉类型（talkative 龙王 / performer 群聊之火 / emotion 快乐源泉）。 */
    honor_type?: "talkative" | "performer" | "emotion";
}

/** 离线文件上传（go-cqhttp 扩展）。 */
export interface OB11OfflineFileNoticeEvent extends OB11BaseEvent {
    post_type: "notice";
    notice_type: "offline_file";
    user_id: number;
    file: OfflineFileInfo;
}

/** 群签到（NapCat 扩展）。 */
export interface OB11GroupSignNoticeEvent extends OB11BaseEvent {
    post_type: "notice";
    notice_type: "group_sign";
    group_id: number;
    user_id: number;
}

/** 消息表情回应（NapCat 扩展）。 */
export interface OB11MsgEmojiLikeNoticeEvent extends OB11BaseEvent {
    post_type: "notice";
    notice_type: "msg_emoji_like";
    user_id: number;
    group_id: number;
    message_id: number;
    likes: EmojiLikeItem[];
}

/** 群成员头衔变更（NapCat 扩展）。 */
export interface OB11GroupTitleNoticeEvent extends OB11BaseEvent {
    post_type: "notice";
    notice_type: "group_title";
    group_id: number;
    user_id: number;
    title: string;
}

/** OB11 通知事件联合。 */
export type OB11NoticeEvent =
    | OB11GroupUploadNoticeEvent
    | OB11GroupAdminNoticeEvent
    | OB11GroupDecreaseNoticeEvent
    | OB11GroupIncreaseNoticeEvent
    | OB11GroupBanNoticeEvent
    | OB11FriendAddNoticeEvent
    | OB11GroupRecallNoticeEvent
    | OB11FriendRecallNoticeEvent
    | OB11GroupCardNoticeEvent
    | OB11GroupEssenceNoticeEvent
    | OB11NotifyNoticeEvent
    | OB11OfflineFileNoticeEvent
    | OB11GroupSignNoticeEvent
    | OB11MsgEmojiLikeNoticeEvent
    | OB11GroupTitleNoticeEvent;
