/**
 * kernel 原生服务接口类型（wrapper.node 运行时探测产物）
 *
 * 各 NodeIKernel*Service 的语义化描述，由 apis 层消费。
 */
export type {
    BuddyCategory,
    BuddyCoreInfo,
    BuddyListEntry,
    BuddyReq,
    DoubtBuddyReq,
    NodeIKernelBuddyService,
} from "./buddy-service.js";
export type {
    Group,
    GroupBulletin,
    GroupDetailInfo,
    GroupMember,
    GroupNotify,
    GroupRemainAtTimes,
    KickMemberInfo,
    KickMemberV2Req,
    NodeIKernelGroupService,
    ShutUpGroupMember,
} from "./group-service.js";
export {
    GroupNotifyMsgStatus,
    GroupNotifyMsgType,
    NTGroupMemberRole,
    NTGroupRequestOperateTypes,
} from "./group-service.js";
export type {
    GeneralCallResult,
    NodeIKernelMsgService,
    NudgeParam,
    SendMessageElement,
} from "./msg-service.js";
export { ElementType } from "./msg-service.js";
export type {
    BuddyProfileLikeResult,
    NodeIKernelProfileLikeService,
} from "./profile-like-service.js";
export type { NodeIKernelProfileService, UserDetailInfoByUin } from "./profile-service.js";
export type {
    NodeIKernelRecentContactService,
    RecentContact,
    RecentContactFetchParam,
} from "./recent-contact-service.js";
export type {
    GetFileListParam,
    GroupFileItemInfo,
    GroupFolderInfo,
    GroupSpaceInfo,
    NodeIKernelRichMediaService,
} from "./richmedia-service.js";
export type { ForceFetchClientKeyRetType, NodeIKernelTicketService } from "./ticket-service.js";
