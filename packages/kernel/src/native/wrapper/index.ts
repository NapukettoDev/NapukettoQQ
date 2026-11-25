/**
 * wrapper 子域公共出口（L1 原生防腐层 · 装载与生命周期）
 *
 * 原生装载（loader）/ 生命周期编排（lifecycle）/ 回调适配器 / 平台配置 /
 * 版本探测 / session 解析。
 *
 * 运行时反射探针在兄弟目录 `../probe/`，由此不再反向重导出：`native/index.ts`
 * 分别汇总 wrapper / probe / bridge / message-codec，保证 native/ 内部单向无环。
 */

export type {
    QQVersionContext,
    QqVersionContext,
    StartNapukettoOptions,
    WrapperContext,
} from "./lifecycle.js";
export {
    activateO3MiscService,
    createSession,
    createWrapper,
    initEngine,
    initSession,
    startNapuketto,
    startSession,
} from "./lifecycle.js";
export type { BootEnv, QqDataRootOptions } from "./loader.js";
export { dlopenWrapper, electronProcessType, resolveQqUserDataRoot } from "./loader.js";
export { resolveQqGlobalPath } from "./qq-data-path.js";
export { getExistingSession, getMainSession } from "./session-resolver.js";
export type { SessionListenerOptions } from "./wrapper-adapters.js";
export {
    createLoginListener,
    createSessionListener,
    createSessionListener as createLifecycleSessionListener,
    DependsAdapter,
    DispatcherAdapter,
    GlobalAdapter,
} from "./wrapper-adapters.js";
export type { SessionConfigOptions } from "./wrapper-config.js";
export {
    buildEngineConfig,
    buildLoginConfig,
    buildSessionConfig,
    parseAppidFromMajor,
    readMachineGuid,
    resolveAppidQua,
} from "./wrapper-config.js";
export type { QQVersionInfo, QqVersionInfo } from "./wrapper-version.js";
export { listQQVersions, resolveQQVersion, resolveWrapperPath } from "./wrapper-version.js";
