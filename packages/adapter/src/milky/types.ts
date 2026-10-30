/**
 * Milky 协议类型（P0 2026-10-28，P1 2026-10-30）
 *
 * SSOT：Milky 1.3.0 官方 JSON Schema（https://milky.ntqqrev.org/raw/json-schema/schema.json，
 * MIT 许可），本文件为 P1 用到子集的自研描述（逐字段对照 schema 手写，未参考任何
 * GPL 实现源码）；与 schema 的对齐由测试锁字段（helper/*.test.ts）。
 * P2 扩面时按 schema 补齐（或切 @saltify/milky-protocol 生成）。
 */

/** 消息场景（规范三值）。 */
export type MessageScene = "friend" | "group" | "temp";

/** 好友分组实体。 */
export interface FriendCategoryEntity {
    category_id: number;
    category_name: string;
}

/** 好友实体。 */
export interface FriendEntity {
    user_id: number;
    nickname: string;
    sex: "male" | "female" | "unknown";
    qid: string;
    remark: string;
    category: FriendCategoryEntity;
}

/** 群实体。 */
export interface GroupEntity {
    group_id: number;
    group_name: string;
    member_count: number;
    max_member_count: number;
    remark: string;
    created_time: number;
    description: string;
    question: string;
    announcement: string;
}

/** 群成员实体。 */
export interface GroupMemberEntity {
    user_id: number;
    nickname: string;
    sex: "male" | "female" | "unknown";
    group_id: number;
    card: string;
    title: string;
    level: number;
    role: "owner" | "admin" | "member";
    join_time: number;
    last_sent_time: number;
    shut_up_end_time: number | null;
}

/** 接收消息段（14 种，P0 全量建模；与规范 IncomingSegment 一一对应）。 */
export type IncomingSegment =
    | { type: "text"; data: { text: string } }
    | { type: "mention"; data: { user_id: number; name: string } }
    | { type: "mention_all"; data: Record<string, never> }
    | { type: "face"; data: { face_id: string; is_large: boolean } }
    | {
          type: "reply";
          data: {
              message_seq: number;
              sender_id: number;
              sender_name: string | null;
              time: number;
              segments: IncomingSegment[];
          };
      }
    | {
          type: "image";
          data: {
              resource_id: string;
              temp_url: string;
              width: number;
              height: number;
              summary: string;
              sub_type: "normal" | "sticker";
          };
      }
    | { type: "record"; data: { resource_id: string; temp_url: string; duration: number } }
    | {
          type: "video";
          data: {
              resource_id: string;
              temp_url: string;
              width: number;
              height: number;
              duration: number;
          };
      }
    | {
          type: "file";
          data: {
              file_id: string;
              file_name: string;
              file_size: number;
              file_hash?: string | null;
          };
      }
    | {
          type: "forward";
          data: { forward_id: string; title: string; preview: string[]; summary: string };
      }
    | {
          type: "market_face";
          data: {
              emoji_package_id: number;
              emoji_id: string;
              key: string;
              summary: string;
              url: string;
          };
      }
    | { type: "light_app"; data: { app_name: string; json_payload: string } }
    | { type: "xml"; data: { service_id: number; xml_payload: string } }
    | { type: "markdown"; data: { content: string } };

/** 发送消息段（10 种，P0 全量建模；与规范 OutgoingSegment 一一对应）。 */
export type OutgoingSegment =
    | { type: "text"; data: { text: string } }
    | { type: "mention"; data: { user_id: number } }
    | { type: "mention_all"; data: Record<string, never> }
    | { type: "face"; data: { face_id: string; is_large?: boolean | null } }
    | { type: "reply"; data: { message_seq: number } }
    | {
          type: "image";
          data: { uri: string; sub_type?: "normal" | "sticker" | null; summary?: string | null };
      }
    | { type: "record"; data: { uri: string } }
    | { type: "video"; data: { uri: string; thumb_uri?: string | null } }
    | { type: "forward"; data: { messages: unknown[]; title?: string | null } }
    | { type: "light_app"; data: { json_payload: string } };

/** 接收消息（IncomingMessage：friend / group / temp 三形态）。 */
export type IncomingMessage =
    | {
          message_scene: "friend";
          peer_id: number;
          message_seq: number;
          sender_id: number;
          time: number;
          segments: IncomingSegment[];
          friend: FriendEntity;
      }
    | {
          message_scene: "group";
          peer_id: number;
          message_seq: number;
          sender_id: number;
          time: number;
          segments: IncomingSegment[];
          group: GroupEntity;
          group_member: GroupMemberEntity;
      }
    | {
          message_scene: "temp";
          peer_id: number;
          message_seq: number;
          sender_id: number;
          time: number;
          segments: IncomingSegment[];
          group?: GroupEntity | null;
      };

/** 事件信封（规范固定四字段；载荷在 data 内）。 */
export interface MilkyEvent<TData = unknown> {
    time: number;
    self_id: number;
    event_type: string;
    data: TData;
}

/** message_recall 事件载荷。 */
export interface MessageRecallData {
    message_scene: MessageScene;
    peer_id: number;
    message_seq: number;
    sender_id: number;
    operator_id: number;
    display_suffix: string;
}

/** ---------- P0 API 输入/输出 ---------- */

/** get_login_info 响应。 */
export interface GetLoginInfoOutput {
    uin: number;
    nickname: string;
}

/** get_impl_info 响应。 */
export interface GetImplInfoOutput {
    impl_name: string;
    impl_version: string;
    qq_protocol_version: string;
    qq_protocol_type: "windows" | "linux" | "macos";
    milky_version: string;
}

/** send_private_message / send_group_message 响应。 */
export interface SendMessageOutput {
    message_seq: number;
    time: number;
}

/** get_message 响应。 */
export interface GetMessageOutput {
    message: IncomingMessage;
}

/** get_history_messages 响应。 */
export interface GetHistoryMessagesOutput {
    messages: IncomingMessage[];
    next_message_seq: number | null;
}

/** get_forwarded_messages 响应。 */
export interface GetForwardedMessagesOutput {
    messages: IncomingForwardedMessage[];
}

/** get_user_profile 响应。 */
export interface GetUserProfileOutput {
    nickname: string;
    qid: string;
    age: number;
    sex: "male" | "female" | "unknown";
    remark: string;
    bio: string;
    level: number;
    country: string;
    city: string;
    school: string;
}

/** get_friend_info 响应。 */
export interface GetFriendInfoOutput {
    friend: FriendEntity;
}

/** get_group_info 响应。 */
export interface GetGroupInfoOutput {
    group: GroupEntity;
}

/** get_group_member_list 响应。 */
export interface GetGroupMemberListOutput {
    members: GroupMemberEntity[];
}

/** get_group_member_info 响应。 */
export interface GetGroupMemberInfoOutput {
    member: GroupMemberEntity;
}

/** get_cookies 响应。 */
export interface GetCookiesOutput {
    cookies: string;
}

/** get_csrf_token 响应。 */
export interface GetCSRFTokenOutput {
    csrf_token: string;
}

/** get_friend_requests 响应。 */
export interface GetFriendRequestsOutput {
    requests: FriendRequestEntity[];
}

/** get_group_notifications 响应。 */
export interface GetGroupNotificationsOutput {
    notifications: GroupNotificationEntity[];
    next_notification_seq: number | null;
}

/** get_group_essence_messages 响应。 */
export interface GetGroupEssenceMessagesOutput {
    messages: GroupEssenceMessage[];
    is_end: boolean;
}

/** get_group_files 响应。 */
export interface GetGroupFilesOutput {
    files: GroupFileEntity[];
    folders: GroupFolderEntity[];
}

/** create_group_folder 响应。 */
export interface CreateGroupFolderOutput {
    folder_id: string;
}

/** get_friend_list 响应。 */
export interface GetFriendListOutput {
    friends: FriendEntity[];
}

/** get_group_list 响应。 */
export interface GetGroupListOutput {
    groups: GroupEntity[];
}

/** ---------- P1 实体 ---------- */

/** 好友请求实体（get_friend_requests 项）。 */
export interface FriendRequestEntity {
    time: number;
    initiator_id: number;
    initiator_uid: string;
    target_user_id: number;
    target_user_uid: string;
    state: "pending" | "accepted" | "rejected" | "ignored";
    comment: string;
    via: string;
    is_filtered: boolean;
}

/** 群通知实体（get_group_notifications 项，5 形态联合）。 */
export type GroupNotificationEntity =
    | {
          type: "join_request";
          group_id: number;
          notification_seq: number;
          is_filtered: boolean;
          initiator_id: number;
          state: "pending" | "accepted" | "rejected" | "ignored";
          operator_id: number | null;
          comment: string;
      }
    | {
          type: "admin_change";
          group_id: number;
          notification_seq: number;
          target_user_id: number;
          is_set: boolean;
          operator_id: number;
      }
    | {
          type: "kick";
          group_id: number;
          notification_seq: number;
          target_user_id: number;
          operator_id: number;
      }
    | {
          type: "quit";
          group_id: number;
          notification_seq: number;
          target_user_id: number;
      }
    | {
          type: "invited_join_request";
          group_id: number;
          notification_seq: number;
          initiator_id: number;
          target_user_id: number;
          state: "pending" | "accepted" | "rejected" | "ignored";
          operator_id: number | null;
      };

/** 群文件实体（get_group_files 项）。 */
export interface GroupFileEntity {
    group_id: number;
    file_id: string;
    file_name: string;
    parent_folder_id: string;
    file_size: number;
    uploaded_time: number;
    expire_time: number | null;
    uploader_id: number;
    downloaded_times: number;
}

/** 群文件夹实体（get_group_files 项）。 */
export interface GroupFolderEntity {
    group_id: number;
    folder_id: string;
    parent_folder_id: string;
    folder_name: string;
    created_time: number;
    last_modified_time: number;
    creator_id: number;
    file_count: number;
}

/** 群精华消息（get_group_essence_messages 项）。 */
export interface GroupEssenceMessage {
    group_id: number;
    message_seq: number;
    message_time: number;
    sender_id: number;
    sender_name: string;
    operator_id: number;
    operator_name: string;
    operation_time: number;
    segments: IncomingSegment[];
}

/** 接收转发消息（get_forwarded_messages 项）。 */
export interface IncomingForwardedMessage {
    message_seq: number;
    sender_name: string;
    avatar_url: string;
    time: number;
    segments: IncomingSegment[];
}

/** ---------- P1 事件载荷 ---------- */

/** friend_request 事件载荷。 */
export interface FriendRequestData {
    initiator_id: number;
    initiator_uid: string;
    comment: string;
    via: string;
}

/** group_join_request 事件载荷。 */
export interface GroupJoinRequestData {
    group_id: number;
    notification_seq: number;
    is_filtered: boolean;
    initiator_id: number;
    comment: string;
}

/** group_invited_join_request 事件载荷。 */
export interface GroupInvitedJoinRequestData {
    group_id: number;
    notification_seq: number;
    initiator_id: number;
    target_user_id: number;
}

/** group_invitation 事件载荷。 */
export interface GroupInvitationData {
    group_id: number;
    invitation_seq: number;
    initiator_id: number;
    source_group_id: number | null;
}

/** group_member_increase 事件载荷。 */
export interface GroupMemberIncreaseData {
    group_id: number;
    user_id: number;
    operator_id: number | null;
    invitor_id: number | null;
}

/** group_member_decrease 事件载荷。 */
export interface GroupMemberDecreaseData {
    group_id: number;
    user_id: number;
    operator_id: number | null;
}

/** group_mute 事件载荷。 */
export interface GroupMuteData {
    group_id: number;
    user_id: number;
    operator_id: number;
    duration: number;
}

/** group_whole_mute 事件载荷。 */
export interface GroupWholeMuteData {
    group_id: number;
    operator_id: number;
    is_mute: boolean;
}

/** friend_nudge 事件载荷。 */
export interface FriendNudgeData {
    user_id: number;
    is_self_send: boolean;
    is_self_receive: boolean;
    display_action: string;
    display_suffix: string;
    display_action_img_url: string;
}

/** group_nudge 事件载荷。 */
export interface GroupNudgeData {
    group_id: number;
    sender_id: number;
    receiver_id: number;
    display_action: string;
    display_suffix: string;
    display_action_img_url: string;
}

/** group_file_upload 事件载荷。 */
export interface GroupFileUploadData {
    group_id: number;
    user_id: number;
    file_id: string;
    file_name: string;
    file_size: number;
}

/** group_name_change 事件载荷。 */
export interface GroupNameChangeData {
    group_id: number;
    new_group_name: string;
    operator_id: number;
}

/** group_disband 事件载荷。 */
export interface GroupDisbandData {
    group_id: number;
    operator_id: number;
}
