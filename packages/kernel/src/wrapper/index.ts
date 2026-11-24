/**
 * wrapper 域公共出口
 *
 * 原生装载（loader）/ 生命周期编排（lifecycle）/ 回调适配器 / 平台配置 /
 * 版本探测 / session 解析 / 运行时反射探针（probe）。
 *
 * 包门面 `src/index.ts` 只转发本 barrel，不再逐文件深路径导出。
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
export type { ListenerRecordEvent, ListenerRecordingResult } from "./probe/index.js";
export { createRecordingListener, probeRuntime, startListenerRecording } from "./probe/index.js";
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
