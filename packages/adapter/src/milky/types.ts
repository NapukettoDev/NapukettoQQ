/**
 * Milky 协议类型（P0 子集，2026-10-28）
 *
 * SSOT：Milky 1.3.0 官方 JSON Schema（https://milky.ntqqrev.org/raw/json-schema/schema.json，
 * MIT 许可），本文件为 P0 用到子集的自研描述（逐字段对照 schema 手写，未参考任何
 * GPL 实现源码）；与 schema 的对齐由测试锁字段（helper/translate.test.ts）。
 * P1 扩面时按 schema 补齐（或切 @saltify/milky-protocol 生成）。
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

/** message_receive 事件载荷 = IncomingMessage。 */
export type MessageReceiveData = IncomingMessage;

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

/** get_friend_list 响应。 */
export interface GetFriendListOutput {
    friends: FriendEntity[];
}

/** get_group_list 响应。 */
export interface GetGroupListOutput {
    groups: GroupEntity[];
}
