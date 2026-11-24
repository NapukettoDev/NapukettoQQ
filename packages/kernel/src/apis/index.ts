/**
 * kernel 业务 API 层公共出口（ADR-009 统一错误语义）
 *
 * 顶层只保留本 barrel 与 result.ts（域内解包工具）；子域：
 * msg / group / social / media-web。
 */

export {
    findPendingGroupRequest,
    GroupApi,
    GroupNotifyApi,
    type GroupRequestKind,
    type GroupRequestRef,
    type PendingGroupRequest,
    toPendingGroupRequest,
} from "./group/index.js";
export type {
    EssenceMsgItem,
    FlashTransferUploadOptions,
    FlashTransferUploadResult,
    GroupFileListItem,
    GroupFileSystemInfo,
    GroupHonorWebInfo,
    HonorListItem,
} from "./media-web/index.js";
export {
    FlashTransferApi,
    RichMediaApi,
    TicketApi,
    WebApi,
    WebHonorType,
} from "./media-web/index.js";
export { MsgApi } from "./msg/index.js";
export type {
    DoubtFriendRequestInfo,
    Friend,
    FriendApiOptions,
    FriendCategory,
    PinnedContact,
    StrangerInfo,
} from "./social/index.js";
export {
    FriendApi,
    ProfileApi,
    ProfileLikeApi,
    RecentContactApi,
} from "./social/index.js";
