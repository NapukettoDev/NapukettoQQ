/**
 * @napuketto/kernel 入口（P0 地基 + P1 前哨）
 *
 * 当前导出：类型化错误（ADR-017）、路径装配（ADR-016）、pino 日志（ADR-007）、
 * JSON 配置基类（ADR-012）、类型化事件通道（ADR-003）、QQ 版本探测（ADR-018）、
 * wrapper NAPI 引导（P1，2026-08-05 重构：loader 截获 exports 后初始化，无 koffi）。
 * apis / cache / login / bridge 均已接入（见下方导出）。
 */

export type {
    DoubtFriendRequestInfo,
    EssenceMsgItem,
    Friend,
    FriendCategory,
    GroupHonorWebInfo,
    HonorListItem,
    StrangerInfo,
} from "./apis/index.js";
export {
    FriendApi,
    GroupApi,
    GroupNotifyApi,
    MsgApi,
    ProfileApi,
    ProfileLikeApi,
    RecentContactApi,
    RichMediaApi,
    TicketApi,
    WebApi,
    WebHonorType,
} from "./apis/index.js";
export type { BuddyEventChannel, GroupEventChannel, MsgEventChannel } from "./bridge/index.js";
export { FriendBridge, GroupBridge, MsgBridge } from "./bridge/index.js";
export type {
    BuddyCacheEventChannel,
    BuddyCacheListener,
    BuddyCacheOptions,
    GroupCacheOptions,
} from "./cache/index.js";
export { BuddyCache, GroupCache, narrowBuddyCategories } from "./cache/index.js";
export type { CoreContext, CoreContextOptions } from "./context.js";
export { createCoreContext } from "./context.js";
export type { CoreLoginOptions, LoginProgress, NapukettoCoreOptions } from "./core.js";
export { NapukettoCore } from "./core.js";
export type { ListenerEvents } from "./event-channel.js";
export { NTEventChannel } from "./event-channel.js";
export type {
    ConfigFormat,
    ConfigOptions,
    ConfigSchema,
    KernelErrorCode,
    LogConfig,
    LogEnvSource,
    LogFileConfig,
    LogFormat,
    LoggerOptions,
    LogLevel,
    LogModuleName,
    PathOptions,
    TimestampMode,
} from "./infra/index.js";
export {
    ConfigBase,
    ConfigError,
    configError,
    createLogger,
    DEFAULT_DATA_ROOT_NAME,
    EXIT_CONFIG_INVALID,
    isKernelError,
    KERNEL_ERROR_CODES,
    KernelError,
    kernelError,
    MAIN_CONFIG_FILE,
    PathWrapper,
    parseLogConfig,
    parseToml,
    resolveConfigPath,
    resolveDataRoot,
    stringifyToml,
} from "./infra/index.js";
export type {
    LoginAccountInfo,
    LoginListItem,
    LoginResult,
    LoginState,
    QrCodeData,
    SelfInfo,
} from "./login/index.js";
export {
    initAndStartSession,
    listLoginAccounts,
    QrLoginSession,
    quickLogin,
    waitForNetworkConnection,
    waitSessionReady,
} from "./login/index.js";
export type {
    BuddyCategory,
    BuddyCoreInfo,
    BuddyListEntry,
    BuddyListener,
    BuddyReq,
    CanonicalElement,
    DesktopPathConfig,
    DeviceInfo,
    DoubtBuddyReq,
    EnginInitDesktopConfig,
    ForceFetchClientKeyRetType,
    GeneralCallResult,
    GetFileListParam,
    GrayTipElement,
    GrayTipRevokeElement,
    Group,
    GroupBulletin,
    GroupDetailInfo,
    GroupFileItemInfo,
    GroupFolderInfo,
    GroupListener,
    GroupMember,
    GroupMemberDataSource,
    GroupMemberListChange,
    GroupNotify,
    GroupSpaceInfo,
    MsgListener,
    NodeIDependsAdapter,
    NodeIDispatcherAdapter,
    NodeIGlobalAdapter,
    NodeIKernelBuddyService,
    NodeIKernelGroupService,
    NodeIKernelLoginService,
    NodeIKernelMsgService,
    NodeIKernelProfileLikeService,
    NodeIKernelProfileService,
    NodeIKernelRecentContactService,
    NodeIKernelRichMediaService,
    NodeIKernelSessionListener,
    NodeIKernelTicketService,
    NodeIQQNTStartupSessionWrapper,
    NodeIQQNTWrapperEngine,
    NodeIQQNTWrapperSession,
    NodeQQNTWrapperUtil,
    NudgeParam,
    Peer,
    PlatformType,
    RawElement,
    RawMessage,
    RDeliveryConfig,
    RecentContact,
    RecentContactFetchParam,
    SendMessageElement,
    ShutUpGroupMember,
    TipAioOpGrayTipElement,
    TipGroupElement,
    UserDetailInfoByUin,
    VendorType,
    WrapperNodeApi,
    WrapperSessionInitConfig,
} from "./types/index.js";
export {
    ChatType,
    ElementType,
    GrayTipSubType,
    GroupListUpdateType,
    GroupNotifyMsgStatus,
    GroupNotifyMsgType,
    NTGroupMemberRole,
    NTGroupRequestOperateTypes,
    TipGroupElementType,
    toCanonicalElements,
    toSendElements,
} from "./types/index.js";
export {
    createRecordingListener,
    type ListenerRecordEvent,
    type ListenerRecordingResult,
    probeRuntime,
    startListenerRecording,
} from "./wrapper/probe/index.js";
export { resolveQqGlobalPath } from "./wrapper/qq-data-path.js";
export { getExistingSession, getMainSession } from "./wrapper/session-resolver.js";
export {
    createLoginListener,
    createSessionListener,
    createSessionListener as createLifecycleSessionListener,
} from "./wrapper/wrapper-adapters.js";
export type { SessionConfigOptions } from "./wrapper/wrapper-config.js";
export {
    buildEngineConfig,
    buildLoginConfig,
    buildSessionConfig,
    parseAppidFromMajor,
    readMachineGuid,
    resolveAppidQua,
} from "./wrapper/wrapper-config.js";
export type {
    BootEnv,
    QQVersionContext,
    StartNapukettoOptions,
    WrapperContext,
} from "./wrapper/wrapper-loader.js";
export {
    createSession,
    createWrapper,
    electronProcessType,
    initEngine,
    initSession,
    resolveQqUserDataRoot,
    startNapuketto,
    startSession,
} from "./wrapper/wrapper-loader.js";
export type { QQVersionInfo } from "./wrapper/wrapper-version.js";
export { listQQVersions, resolveQQVersion, resolveWrapperPath } from "./wrapper/wrapper-version.js";
