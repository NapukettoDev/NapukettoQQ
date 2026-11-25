/**
 * @napuketto/loader 入口
 *
 * 职责：自建宿主引导（2026-08-07 唯一路线）——标准 node + stub QQNT.dll 直接
 * dlopen wrapper.node 并启动 kernel（launchSelfHost → dist/host/self-host.cjs）。
 *
 * 目录分组（2026-11-11）：
 *  - qq/        腾讯产物获取链（定位 / 清单 / 下载 / 解包）
 *  - boot/      宿主进程装配与拉起（launcher / linux-native / win-node）
 *  - lifecycle/ 进程治理（单实例锁 / cmdline 探活 / 优雅关停）
 *  - internal/  包内小工具（数据根 / 包元数据）
 *  - host/      自建宿主进程内运行时（self-host / bootstrap / IPC）
 *
 * 注：V1 注入框架（bootmain/hookdll）与 V2 载具（vehicle）已归档 archive/，
 * 本包不再编译 C++ 组件，业务层 100% 走 NAPI。
 */

export type { LaunchOptions, LaunchResult } from "./boot/launcher.js";
export { defaultStubDir, ENV, launchSelfHost } from "./boot/launcher.js";
export type { SystemNodeInfo, WinHostNodeResolvers, WinNodeInfo } from "./boot/win-node.js";
export {
    ensureWinNode,
    findSystemNode,
    isNodeExecutable,
    nodeZipUrl,
    resolveWinHostNode,
    WIN_NODE_DIR_NAME,
} from "./boot/win-node.js";
export { QR_LINE_PREFIX } from "./host/constants.js";
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
} from "./host/ipc/index.js";
// IPC 协议契约（koishi 插件 ↔ self-host 子进程，zod 单一来源）：
// 类型 + schema 值统一经 host/ipc/index.js 出口，插件侧 import 同一份定义。
// wrapper 原生噪音行判定（cli 转发与 koishi IPC 共享单一来源，见 host/ipc/native-noise.ts）。
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
    isNativeNoiseLine,
} from "./host/ipc/index.js";
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
export { locateQqPath, resolveQqInstall } from "./qq/install-probe.js";
export type { QqFileSource, QqInstallInfo, ResolveQqFilesOptions } from "./qq/locate-qq.js";
export { ensureQqFiles, QQ_FILES_DIR_NAME, resolveQqFiles } from "./qq/locate-qq.js";
export type { DownloadOptions, DownloadResult } from "./qq/qq-download.js";
export { DownloadError, downloadFile } from "./qq/qq-download.js";
export type { ExtractOptions } from "./qq/qq-extract.js";
export {
    clearCacheVersion,
    extractDebInstaller,
    extractInstaller,
    extractLinuxWrapperFiles,
    extractWrapperFiles,
    isLinuxRuntimeFile,
} from "./qq/qq-extract.js";
export type {
    LatestReleaseOptions,
    QqReleaseArch,
    QqReleaseEntry,
    QqReleasePlatform,
    QqReleasesFile,
} from "./qq/qq-releases.js";
export {
    latestRelease,
    loadQqReleases,
    QQ_RELEASES_SCHEMA,
    QqReleasesError,
    releaseArch,
    releasePlatform,
    resolveDownloadUrl,
} from "./qq/qq-releases.js";
export type { SevenZipResult } from "./qq/seven-zip.js";
export { ensureLinuxSevenZip, findSevenZip, linuxSevenZipUrl } from "./qq/seven-zip.js";
