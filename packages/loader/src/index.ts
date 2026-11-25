/**
 * @napuketto/loader 入口：只从各领域目录的真实定义源具名转发，不承载逻辑。
 * 自建宿主路线——标准 node + stub QQNT.dll 直接 dlopen wrapper.node 后启动 kernel。
 */

export type { DownloadOptions, DownloadResult } from "./artifacts/download.js";
export { DownloadError, downloadFile } from "./artifacts/download.js";
export type { ExtractOptions } from "./artifacts/extract.js";
export {
    clearCacheVersion,
    extractDebInstaller,
    extractInstaller,
    extractLinuxWrapperFiles,
    extractWrapperFiles,
    isLinuxRuntimeFile,
} from "./artifacts/extract.js";
export { locateQqPath, resolveQqInstall } from "./artifacts/install-probe.js";
export { ensureQqFiles, QQ_FILES_DIR_NAME, resolveQqFiles } from "./artifacts/locate.js";
export type {
    QqReleaseArch,
    QqReleaseEntry,
    QqReleasePlatform,
    QqReleasesFile,
} from "./artifacts/manifests/releases.js";
export {
    QQ_RELEASES_SCHEMA,
    releaseArch,
    releasePlatform,
} from "./artifacts/manifests/releases.js";
export type { LatestReleaseOptions } from "./artifacts/releases.js";
export {
    latestRelease,
    loadQqReleases,
    QqReleasesError,
    resolveDownloadUrl,
} from "./artifacts/releases.js";
export type { SevenZipResult } from "./artifacts/seven-zip.js";
export { ensureLinuxSevenZip, findSevenZip, linuxSevenZipUrl } from "./artifacts/seven-zip.js";
export type { QqFileSource, QqInstallInfo, ResolveQqFilesOptions } from "./artifacts/types.js";
export { ENV } from "./boot/env-keys.js";
export type { LaunchOptions, LaunchResult } from "./boot/launcher.js";
export { defaultStubDir, launchSelfHost } from "./boot/launcher.js";
export type { SystemNodeInfo, WinHostNodeResolvers, WinNodeInfo } from "./boot/win-node.js";
export {
    ensureWinNode,
    findSystemNode,
    isNodeExecutable,
    nodeZipUrl,
    resolveWinHostNode,
    WIN_NODE_DIR_NAME,
} from "./boot/win-node.js";
export { QR_LINE_PREFIX } from "./contract/constants.js";
export type {
    IpcActionMessage,
    IpcActionPayload,
    IpcBootPhase,
    IpcControlMessage,
    IpcControlPayload,
    IpcEventMessage,
    IpcEventPayload,
    IpcLoginMessage,
    IpcLoginPayload,
    IpcLogLevel,
    IpcLogMessage,
    IpcLogPayload,
    IpcMessage,
    IpcPingMessage,
    IpcPongMessage,
    IpcQrMessage,
    IpcResultMessage,
    IpcResultPayload,
    IpcStatusMessage,
    IpcStatusPayload,
} from "./contract/ipc-schema.js";
// IPC 协议契约（koishi 插件 ↔ self-host 子进程，zod 单一来源）：
// 类型 + schema 值统一从 contract/ipc-schema.ts 出口，插件侧 import 同一份定义。
export {
    DEFAULT_MAX_IPC_LINE_BYTES,
    DEFAULT_MAX_PENDING_REQUESTS,
    IPC_VERSION,
    IpcActionPayloadSchema,
    IpcBootPhaseSchema,
    IpcControlPayloadSchema,
    IpcEventPayloadSchema,
    type IpcFriend,
    IpcFriendSchema,
    type IpcGroupRequest,
    IpcGroupRequestSchema,
    IpcLoginPayloadSchema,
    IpcLogLevelSchema,
    IpcLogPayloadSchema,
    IpcMessageSchema,
    type IpcRespondToGroupRequestParams,
    IpcRespondToGroupRequestParamsSchema,
    IpcResultPayloadSchema,
    IpcStatusPayloadSchema,
    /** @deprecated 请使用 `IpcActionPayloadSchema` */
    ipcActionPayloadSchema,
    /** @deprecated 请使用 `IpcBootPhaseSchema` */
    ipcBootPhaseSchema,
    /** @deprecated 请使用 `IpcControlPayloadSchema` */
    ipcControlPayloadSchema,
    /** @deprecated 请使用 `IpcEventPayloadSchema` */
    ipcEventPayloadSchema,
    /** @deprecated 请使用 `IpcLoginPayloadSchema` */
    ipcLoginPayloadSchema,
    /** @deprecated 请使用 `IpcLogLevelSchema` */
    ipcLogLevelSchema,
    /** @deprecated 请使用 `IpcLogPayloadSchema` */
    ipcLogPayloadSchema,
    /** @deprecated 请使用 `IpcMessageSchema` */
    ipcMessageSchema,
    /** @deprecated 请使用 `IpcResultPayloadSchema` */
    ipcResultPayloadSchema,
    /** @deprecated 请使用 `IpcStatusPayloadSchema` */
    ipcStatusPayloadSchema,
} from "./contract/ipc-schema.js";
// wrapper 原生噪音行判定（cli 转发与 koishi IPC 共享单一来源）。
export { isNativeNoiseLine } from "./contract/native-noise.js";
export type { InstanceLockCheck, InstanceLockInfo } from "./lifecycle/instance-lock.js";
export {
    acquireInstanceLock,
    checkInstanceLock,
    INSTANCE_LOCK_FILE,
    registerLockCleanup,
    releaseInstanceLock,
} from "./lifecycle/instance-lock.js";
// 跨进程 cmdline 查询（instance-lock pid 复用校验 + cli 树杀前身份校验共用单一来源）
export {
    CMDLINE_PROBE_SUPPORTED,
    isValidPid,
    MAX_PID,
    normalizeCmdline,
    readCmdlineForPid,
} from "./lifecycle/pid-cmdline.js";
// 优雅关停（停止哨兵 + 关停钩子 + 信号接入；supervisor / cli boot / self-host 共用）
export type { StopSentinelWatchOptions } from "./lifecycle/shutdown.js";
export {
    accountStopSentinelPath,
    installSignalShutdown,
    registerShutdownHook,
    removeAccountStopSentinel,
    removeStopSentinel,
    requestShutdown,
    STOP_SENTINEL_FILENAME,
    stopSentinelPath,
    watchStopSentinel,
    writeAccountStopSentinel,
    writeStopSentinel,
} from "./lifecycle/shutdown.js";
