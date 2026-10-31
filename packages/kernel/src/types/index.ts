/**
 * kernel 类型层公共出口
 *
 * 语义化实体（entities / message-element）+ 原生句柄面（wrapper）+
 * 子域类型（listeners / services，各有独立 barrel）。
 * 全部类型为运行时探测产物（packages/kernel/scripts/probe/），非拍脑袋定义。
 */
export type {
    FaceElement,
    FileElement,
    GrayTipElement,
    GrayTipRevokeElement,
    Peer,
    PicElement,
    PttElement,
    RawElement,
    RawMessage,
    ReplyElement,
    TextElement,
    TipAioOpGrayTipElement,
    TipGroupElement,
    VideoElement,
} from "./entities.js";
export { ChatType, GrayTipSubType, TipGroupElementType } from "./entities.js";
export type {
    BuddyListener,
    GroupListener,
    GroupMemberListChange,
    MsgListener,
    MsgReadReportItem,
    MsgReceipt,
} from "./listeners/index.js";
export { GroupListUpdateType, GroupMemberDataSource } from "./listeners/index.js";
export type { CanonicalElement } from "./message-element.js";
export { toCanonicalElements, toSendElements } from "./message-element.js";
export type {
    BuddyCategory,
    BuddyCoreInfo,
    BuddyListEntry,
    BuddyProfileLikeResult,
    BuddyReq,
    DoubtBuddyReq,
    ForceFetchClientKeyRetType,
    GeneralCallResult,
    GetFileListParam,
    Group,
    GroupBulletin,
    GroupDetailInfo,
    GroupFileItemInfo,
    GroupFolderInfo,
    GroupMember,
    GroupNotify,
    GroupRemainAtTimes,
    GroupSpaceInfo,
    KickMemberInfo,
    KickMemberV2Req,
    NodeIKernelBuddyService,
    NodeIKernelGroupService,
    NodeIKernelMsgService,
    NodeIKernelProfileLikeService,
    NodeIKernelProfileService,
    NodeIKernelRecentContactService,
    NodeIKernelRichMediaService,
    NodeIKernelTicketService,
    NudgeParam,
    RecentContact,
    RecentContactFetchParam,
    SendMessageElement,
    ShutUpGroupMember,
    UserDetailInfoByUin,
} from "./services/index.js";
export {
    ElementType,
    GroupNotifyMsgStatus,
    GroupNotifyMsgType,
    NTGroupMemberRole,
    NTGroupRequestOperateTypes,
} from "./services/index.js";
export type {
    DesktopPathConfig,
    DeviceInfo,
    EnginInitDesktopConfig,
    IKernelLoginListener,
    NodeIDependsAdapter,
    NodeIDispatcherAdapter,
    NodeIGlobalAdapter,
    NodeIKernelLoginService,
    NodeIKernelLoginServiceCtor,
    NodeIKernelSessionListener,
    NodeIO3MiscService,
    NodeIQQNTStartupSessionWrapper,
    NodeIQQNTStartupSessionWrapperCtor,
    NodeIQQNTWrapperEngine,
    NodeIQQNTWrapperEngineCtor,
    NodeIQQNTWrapperSession,
    NodeIQQNTWrapperSessionCtor,
    NodeQQNTWrapperUtil,
    RDeliveryConfig,
    WrapperNodeApi,
    WrapperSessionInitConfig,
} from "./wrapper.js";
export { PlatformType, VendorType } from "./wrapper.js";
