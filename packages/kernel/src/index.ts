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
    FlashTransferUploadOptions,
    FlashTransferUploadResult,
    Friend,
    FriendApiOptions,
    FriendCategory,
    GroupFileListItem,
    GroupFileSystemInfo,
    GroupHonorWebInfo,
    HonorListItem,
    PinnedContact,
    StrangerInfo,
} from "./apis/index.js";
export {
    FlashTransferApi,
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
export type {
    BuddyEventChannel,
    GroupEventChannel,
    LoginEventChannel,
    MsgEventChannel,
    RecentContactEventChannel,
} from "./bridge/index.js";
export {
    FriendBridge,
    GroupBridge,
    LoginBridge,
    MsgBridge,
    RecentContactBridge,
} from "./bridge/index.js";
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
    ConfigPathOptions,
    ConfigSchema,
    ConsoleFormatStreamOptions,
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
    createConsoleFormatStream,
    createLogger,
    DEFAULT_DATA_ROOT_NAME,
    EXIT_CONFIG_INVALID,
    errorMessage,
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
    sleep,
    stringifyToml,
    waitFor,
} from "./infra/index.js";
export type {
    LoginAccountInfo,
    LoginListItem,
    LoginResult,
    LoginState,
    QrCodeData,
    QuickLoginOptions,
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
export type { KernelRuntime, KernelRuntimeOptions } from "./runtime.js";
export { createKernelRuntime } from "./runtime.js";
export type {
    BuddyCategory,
    BuddyCoreInfo,
    BuddyListEntry,
    BuddyListener,
    BuddyProfileLikeResult,
    BuddyReq,
    CanonicalElement,
    DesktopPathConfig,
    DeviceInfo,
    DoubtBuddyReq,
    EnginInitDesktopConfig,
    FaceElement,
    FileElement,
    FlashTransferFileSet,
    FlashTransferFileStatus,
    FlashTransferPermission,
    FlashTransferTarget,
    FlashTransferTaskInfo,
    FlashTransferUploadListener,
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
    GroupMemberListChange,
    GroupNotify,
    GroupRemainAtTimes,
    GroupSpaceInfo,
    IKernelLoginListener,
    KernelLoginListener,
    KickMemberInfo,
    KickMemberV2Req,
    LoginListener,
    MsgListener,
    MsgReadReportItem,
    MsgReceipt,
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
    PicElement,
    PlatformType,
    PttElement,
    RawElement,
    RawMessage,
    RDeliveryConfig,
    RecentContact,
    RecentContactFetchParam,
    RecentContactListChanged,
    RecentContactListener,
    ReplyElement,
    SendMessageElement,
    ShutUpGroupMember,
    TextElement,
    TipAioOpGrayTipElement,
    TipGroupElement,
    UserDetailInfoByUin,
    VendorType,
    VideoElement,
    WrapperNodeApi,
    WrapperSessionInitConfig,
} from "./types/index.js";
export {
    ChatType,
    ElementType,
    GrayTipSubType,
    GroupListUpdateType,
    GroupMemberDataSource,
    GroupNotifyMsgStatus,
    GroupNotifyMsgType,
    NTGroupMemberRole,
    NTGroupRequestOperateTypes,
    TipGroupElementType,
    toCanonicalElements,
    toSendElements,
    VIDEO_THUMB_KEY,
} from "./types/index.js";
export {
    hasBooleanProp,
    hasFunctionProp,
    hasNumberProp,
    hasStringProp,
    isRecord,
    requireKernelService,
} from "./utils/type-guards.js";
export {
    createRecordingListener,
    type ListenerRecordEvent,
    type ListenerRecordingResult,
    /** @internal 运行时反射探测工具 */
    probeRuntime,
    /** @internal 运行时反射探测工具 */
    startListenerRecording,
} from "./wrapper/probe/index.js";
export { resolveQqGlobalPath } from "./wrapper/qq-data-path.js";
export {
    /** @internal 仅供 probe 诊断参考，请勿在业务装配中直接调用 */
    getExistingSession,
    /** @internal 仅供 probe 诊断参考，请勿在业务装配中直接调用 */
    getMainSession,
} from "./wrapper/session-resolver.js";
export type { SessionListenerOptions } from "./wrapper/wrapper-adapters.js";
export {
    createLoginListener,
    createSessionListener,
    createSessionListener as createLifecycleSessionListener,
    DependsAdapter,
    DispatcherAdapter,
    GlobalAdapter,
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
    QqDataRootOptions,
    QqVersionContext,
    StartNapukettoOptions,
    WrapperContext,
} from "./wrapper/wrapper-loader.js";
export {
    activateO3MiscService,
    createSession,
    createWrapper,
    dlopenWrapper,
    electronProcessType,
    initEngine,
    initSession,
    resolveQqUserDataRoot,
    startNapuketto,
    startSession,
} from "./wrapper/wrapper-loader.js";
export type { QQVersionInfo, QqVersionInfo } from "./wrapper/wrapper-version.js";
export { listQQVersions, resolveQQVersion, resolveWrapperPath } from "./wrapper/wrapper-version.js";
