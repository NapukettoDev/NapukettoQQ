/**
 * @napuketto/adapter milky 子路径入口
 *
 * Milky 协议适配器 + 完整公共面（API 聚合 / 动作注册表 / 传输装配 / 协议类型），
 * 对齐 ./onebot11 与 ./satori 的导出口径。装配方（loader assemble-protocols）
 * 动态 import 本入口。
 */

export { milkyErrorCodeMap } from "./action/base-action.js";
export type { MilkyAction } from "./action/index.js";
export { createMilkyActionRegistry } from "./action/index.js";
export type { MilkyAdapterOptions } from "./adapter.js";
export { NapukettoMilkyAdapter } from "./adapter.js";
export type { MilkyApiOptions } from "./api.js";
export { MilkyApi } from "./api.js";
export type { MilkyConfig } from "./config.js";
export { milkyConfigSchema } from "./config.js";
export type { MilkyLoggerLike, MilkyTransportSet } from "./transport.js";
export { assembleMilkyTransports } from "./transport.js";
export type {
    BotOfflineData,
    FriendCategoryEntity,
    FriendEntity,
    FriendRequestData,
    FriendRequestEntity,
    GetCookiesOutput,
    GetImplInfoOutput,
    GetLoginInfoOutput,
    GroupAnnouncementEntity,
    GroupDisbandData,
    GroupEntity,
    GroupEssenceMessage,
    GroupFileEntity,
    GroupFileUploadData,
    GroupFolderEntity,
    GroupInvitationData,
    GroupInvitedJoinRequestData,
    GroupJoinRequestData,
    GroupMemberDecreaseData,
    GroupMemberEntity,
    GroupMemberIncreaseData,
    GroupMessageReactionData,
    GroupMuteData,
    GroupNameChangeData,
    GroupNotificationEntity,
    GroupWholeMuteData,
    IncomingForwardedMessage,
    IncomingMessage as MilkyIncomingMessage,
    IncomingSegment as MilkyIncomingSegment,
    MessageRecallData,
    MessageScene,
    MilkyEvent,
    OutgoingForwardedMessage,
    OutgoingSegment as MilkyOutgoingSegment,
    PeerPinChangeData,
    SendMessageOutput,
} from "./types.js";
