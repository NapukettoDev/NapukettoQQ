/**
 * kernel 原生监听器类型（事件通道泛型参数）
 *
 * buddy / group / msg / recent-contact / login 方向的 listener 契约，由 bridge 层消费。
 */
export type { BuddyListener } from "./buddy.js";
export type { GroupListener, GroupMemberListChange } from "./group.js";
export { GroupListUpdateType, GroupMemberDataSource } from "./group.js";
export type { LoginListener } from "./login.js";
export type { MsgListener, MsgReadReportItem, MsgReceipt } from "./msg.js";
export type { RecentContactListChanged, RecentContactListener } from "./recent-contact.js";
