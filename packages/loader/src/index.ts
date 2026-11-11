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
export type { WinNodeInfo } from "./boot/win-node.js";
export { ensureWinNode, nodeZipUrl, WIN_NODE_DIR_NAME } from "./boot/win-node.js";
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
} from "./host/ipc/ipc-types.js";
// IPC 协议契约（koishi 插件 ↔ self-host 子进程，zod 单一来源）。
// koishi 插件侧 import 同一份 schema/类型，替代原 src/ipc/types.ts 手工镜像。
export {
    IPC_VERSION,
    IpcActionPayloadSchema,
    IpcBootPhaseSchema,
    IpcControlPayloadSchema,
    IpcEventPayloadSchema,
    IpcLoginPayloadSchema,
    IpcLogLevelSchema,
    IpcLogPayloadSchema,
    IpcMessageSchema,
    IpcResultPayloadSchema,
    IpcStatusPayloadSchema,
} from "./host/ipc/ipc-types.js";
// wrapper 原生噪音行判定（cli 转发与 koishi IPC 共享单一来源，见 host/ipc/native-noise.ts）。
export { isNativeNoiseLine } from "./host/ipc/native-noise.js";
export type { InstanceLockCheck, InstanceLockInfo } from "./lifecycle/instance-lock.js";
export {
    acquireInstanceLock,
    checkInstanceLock,
    INSTANCE_LOCK_FILE,
    registerLockCleanup,
    releaseInstanceLock,
} from "./lifecycle/instance-lock.js";
// 跨进程 cmdline 查询（instance-lock pid 复用校验的底层探针，诊断/工具可独立使用）
export { readCmdlineForPid } from "./lifecycle/pid-cmdline.js";
// 优雅关停（停止哨兵 + 关停钩子 + 信号接入；supervisor / cli boot / self-host 共用）
export type { StopSentinelWatchOptions } from "./lifecycle/shutdown.js";
export {
    installSignalShutdown,
    registerShutdownHook,
    removeStopSentinel,
    requestShutdown,
    STOP_SENTINEL_FILENAME,
    stopSentinelPath,
    watchStopSentinel,
    writeStopSentinel,
} from "./lifecycle/shutdown.js";
export type { QqFileSource, QqInstallInfo, ResolveQqFilesOptions } from "./qq/locate-qq.js";
export {
    ensureLinuxSevenZip,
    ensureQqFiles,
    linuxSevenZipUrl,
    locateQqPath,
    QQ_FILES_DIR_NAME,
    resolveQqFiles,
    resolveQqInstall,
} from "./qq/locate-qq.js";
export type { DownloadOptions, DownloadResult } from "./qq/qq-download.js";
export { DownloadError, downloadFile } from "./qq/qq-download.js";
export type { ExtractOptions, SevenZipResult } from "./qq/qq-extract.js";
export {
    clearCacheVersion,
    extractDebInstaller,
    extractInstaller,
    extractLinuxWrapperFiles,
    extractWrapperFiles,
    findSevenZip,
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
