/**
 * OneBot 11 事件模型：message / notice / request / meta 四类可判别联合
 *
 * adapter.ts订阅 kernel 事件后按此模型产出 OB11 事件广播；
 * 第三方框架消费时按 post_type 收窄。
 */

import type { OB11MessageEvent as MessageEventUnion } from "./message.js";
import type { OB11MetaEvent as MetaEventUnion } from "./meta.js";
import type { OB11NoticeEvent as NoticeEventUnion } from "./notice.js";
import type { OB11RequestEvent as RequestEventUnion } from "./request.js";

export type { OB11BaseEvent, OB11PostType } from "./base.js";
export type {
    Anonymous,
    GroupSender,
    OB11GroupMessageEvent,
    OB11MessageEvent,
    OB11PrivateMessageEvent,
} from "./message.js";
export type {
    OB11HeartbeatMetaEvent,
    OB11LifecycleMetaEvent,
    OB11MetaEvent,
    OB11Status,
} from "./meta.js";
export type {
    EmojiLikeItem,
    GroupFileInfo,
    OB11FriendAddNoticeEvent,
    OB11FriendRecallNoticeEvent,
    OB11GroupAdminNoticeEvent,
    OB11GroupBanNoticeEvent,
    OB11GroupCardNoticeEvent,
    OB11GroupDecreaseNoticeEvent,
    OB11GroupEssenceNoticeEvent,
    OB11GroupIncreaseNoticeEvent,
    OB11GroupRecallNoticeEvent,
    OB11GroupSignNoticeEvent,
    OB11GroupTitleNoticeEvent,
    OB11GroupUploadNoticeEvent,
    OB11MsgEmojiLikeNoticeEvent,
    OB11NoticeEvent,
    OB11NotifyNoticeEvent,
    OB11OfflineFileNoticeEvent,
    OfflineFileInfo,
} from "./notice.js";
export type { OB11FriendRequestEvent, OB11GroupRequestEvent, OB11RequestEvent } from "./request.js";

/** OB11 事件联合（所有事件共用 time/self_id/post_type，按 post_type 收窄）。 */
export type OB11Event = MessageEventUnion | NoticeEventUnion | RequestEventUnion | MetaEventUnion;
