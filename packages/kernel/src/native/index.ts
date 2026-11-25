/**
 * native/ 公共出口（L1 原生防腐层）
 *
 * 唯一允许触碰 `process.dlopen` / `wrapper.node` 的层。四个子域单向并列、互不
 * 反向重导出（消除旧 `wrapper <-> probe` 隐性双向依赖）：
 *   - message-codec：canonical 消息元素 ↔ NT 元素双向转换
 *   - bridge：5 条原生 listener 桥 + 图片落盘宽限
 *   - probe：运行时反射探针（类型层产物的来源）
 *   - wrapper：dlopen、加载生命周期、平台配置、回调适配、版本探测
 *
 * 只允许依赖 `types/`（L0）与 `infra/`（L0）；`apis/`（L2）与 `runtime/`（L3）
 * 不得被本层引用。禁 `export *`（biome performance/noReExportAll）。
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
