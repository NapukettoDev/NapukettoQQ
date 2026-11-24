/**
 * 媒体 / Web API 域公共出口：富媒体、闪传、Ticket、Web 侧数据。
 */
export type {
    FlashTransferUploadOptions,
    FlashTransferUploadResult,
} from "./flash-transfer.js";
export { FlashTransferApi } from "./flash-transfer.js";
export type { GroupFileListItem, GroupFileSystemInfo } from "./richmedia.js";
export { RichMediaApi } from "./richmedia.js";
export { TicketApi } from "./ticket.js";
export type { EssenceMsgItem, GroupHonorWebInfo, HonorListItem } from "./webapi.js";
export { WebApi, WebHonorType } from "./webapi.js";
