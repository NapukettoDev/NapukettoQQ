/**
 * kernel 业务 API 层公共出口（ADR-009 统一错误语义）。
 * L2 无状态语义 API 层：只依赖 `types/`（L0）、`infra/`（L0）与 `native/`（L1），
 * 不得引用 `runtime/`（登录 / 缓存 / 装配）；子域：msg / group / social。
 */

export type {
    FlashTransferUploadOptions,
    FlashTransferUploadResult,
} from "./flash-transfer.js";
export { FlashTransferApi } from "./flash-transfer.js";
export {
    findPendingGroupRequest,
    GroupApi,
    GroupNotifyApi,
    type GroupRequestKind,
    type GroupRequestRef,
    type PendingGroupRequest,
    toPendingGroupRequest,
} from "./group/index.js";
export { MsgApi } from "./msg/index.js";
export type { GroupFileListItem, GroupFileSystemInfo } from "./rich-media.js";
export { RichMediaApi } from "./rich-media.js";
export type {
    DoubtFriendRequestInfo,
    Friend,
    FriendApiOptions,
    FriendCategory,
    PinnedContact,
    StrangerInfo,
} from "./social/index.js";
export { FriendApi, ProfileApi, ProfileLikeApi, RecentContactApi } from "./social/index.js";
export { TicketApi } from "./ticket.js";
export type { EssenceMsgItem, GroupHonorWebInfo, HonorListItem } from "./web.js";
export { WebApi, WebHonorType } from "./web.js";
