/**
 * kernel 业务 API 层公共出口（ADR-009 统一错误语义）
 *
 * 各原生 service 的语义化封装。result.ts 为域内解包工具（同目录直接引用），
 * 不对外暴露。
 */
export type {
    DoubtFriendRequestInfo,
    Friend,
    FriendApiOptions,
    FriendCategory,
} from "./friend.js";
export { FriendApi } from "./friend.js";
export { GroupApi } from "./group.js";
export { GroupNotifyApi } from "./group-notify.js";
export { MsgApi } from "./msg.js";
export { ProfileApi } from "./profile.js";
export { ProfileLikeApi } from "./profile-like.js";
export type { PinnedContact } from "./recent-contact.js";
export { RecentContactApi } from "./recent-contact.js";
export type { GroupFileListItem, GroupFileSystemInfo } from "./richmedia.js";
export { RichMediaApi } from "./richmedia.js";
export type { StrangerInfo } from "./stranger-info.js";
export { TicketApi } from "./ticket.js";
export type { EssenceMsgItem, GroupHonorWebInfo, HonorListItem } from "./webapi.js";
export { WebApi, WebHonorType } from "./webapi.js";
