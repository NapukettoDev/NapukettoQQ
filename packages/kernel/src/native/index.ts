/**
 * native/ 公共出口（L1 原生防腐层）：唯一允许触碰 `process.dlopen` / `wrapper.node` 的层。
 * 子域 message-codec / bridge / probe / wrapper 单向并列、互不反向重导出（避免隐性双向依赖）；
 * 只依赖 `types/`（L0）与 `infra/`（L0），禁 `export *`（biome performance/noReExportAll）。
 */

// ---- bridge ----
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
// ---- message-codec ----
export {
    picLocalCandidates,
    toCanonicalElements,
    toSendElements,
} from "./message-codec.js";
// ---- probe ----
export type { ListenerRecordEvent, ListenerRecordingResult } from "./probe/index.js";
/** @internal 运行时反射探测工具 */
export { createRecordingListener, probeRuntime, startListenerRecording } from "./probe/index.js";
// ---- wrapper ----
export type {
    BootEnv,
    QQVersionContext,
    QQVersionInfo,
    QqDataRootOptions,
    QqVersionContext,
    QqVersionInfo,
    SessionConfigOptions,
    SessionListenerOptions,
    StartNapukettoOptions,
    WrapperContext,
} from "./wrapper/index.js";
export {
    activateO3MiscService,
    buildEngineConfig,
    buildLoginConfig,
    buildSessionConfig,
    createLifecycleSessionListener,
    createLoginListener,
    createSession,
    createSessionListener,
    createWrapper,
    DependsAdapter,
    DispatcherAdapter,
    dlopenWrapper,
    electronProcessType,
    GlobalAdapter,
    getExistingSession,
    getMainSession,
    initEngine,
    initSession,
    listQQVersions,
    parseAppidFromMajor,
    readMachineGuid,
    resolveAppidQua,
    resolveQQVersion,
    resolveQqGlobalPath,
    resolveQqUserDataRoot,
    resolveWrapperPath,
    startNapuketto,
    startSession,
} from "./wrapper/index.js";
