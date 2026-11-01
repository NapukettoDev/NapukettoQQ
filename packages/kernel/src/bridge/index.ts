/**
 * kernel 事件桥公共出口
 *
 * 把原生 service 回调推入类型化事件通道（ADR-003）：群事件（GroupBridge）+
 * 消息事件（MsgBridge）+ 好友事件（FriendBridge）+ 会话列表（RecentContactBridge）+
 * 登录状态（LoginBridge）。缓存维护与协议层都订阅 channel。
 */
export type { BuddyEventChannel } from "./friend-bridge.js";
export { FriendBridge } from "./friend-bridge.js";
export type { GroupEventChannel } from "./group-bridge.js";
export { GroupBridge } from "./group-bridge.js";
export type { LoginEventChannel } from "./login-bridge.js";
export { LoginBridge } from "./login-bridge.js";
export type { MsgEventChannel } from "./msg-bridge.js";
export { MsgBridge } from "./msg-bridge.js";
export type { RecentContactEventChannel } from "./recent-contact-bridge.js";
export { RecentContactBridge } from "./recent-contact-bridge.js";
