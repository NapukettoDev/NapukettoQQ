/**
 * @napuketto/loader 入口
 *
 * 职责：自建宿主引导（2026-08-07 唯一路线）——标准 node + stub QQNT.dll 直接
 * dlopen wrapper.node 并启动 kernel（launchSelfHost → dist/host/self-host.cjs）。
 *  - locate-qq：定位 QQ 安装 + 版本
 *  - launcher：装配环境变量 + PATH 前置 stub + spawn 标准 node
 *
 * 注：V1 注入框架（bootmain/hookdll）与 V2 载具（vehicle）已归档 archive/，
 * 本包不再编译 C++ 组件，业务层 100% 走 NAPI。
 */

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
export type { InstanceLockCheck, InstanceLockInfo } from "./instance-lock.js";
export {
    acquireInstanceLock,
    checkInstanceLock,
    INSTANCE_LOCK_FILE,
    registerLockCleanup,
    releaseInstanceLock,
} from "./instance-lock.js";
export type { LaunchOptions, LaunchResult } from "./launcher.js";
export { defaultStubDir, ENV, launchSelfHost } from "./launcher.js";
export type { QqFileSource, QqInstallInfo, ResolveQqFilesOptions } from "./locate-qq.js";
export {
    ensureLinuxSevenZip,
    ensureQqFiles,
    linuxSevenZipUrl,
    locateQqPath,
    QQ_FILES_DIR_NAME,
    resolveQqFiles,
    resolveQqInstall,
} from "./locate-qq.js";
// 跨进程 cmdline 查询（instance-lock pid 复用校验的底层探针，诊断/工具可独立使用）
export { readCmdlineForPid } from "./pid-cmdline.js";
export type { DownloadOptions, DownloadResult } from "./qq-download.js";
export { DownloadError, downloadFile } from "./qq-download.js";
export type { ExtractOptions, SevenZipResult } from "./qq-extract.js";
export {
    clearCacheVersion,
    extractInstaller,
    extractWrapperFiles,
    findSevenZip,
} from "./qq-extract.js";
export type { QqReleaseEntry, QqReleasesFile } from "./qq-releases.js";
export {
    latestRelease,
    loadQqReleases,
    QqReleasesError,
    resolveDownloadUrl,
} from "./qq-releases.js";
// 优雅关停（停止哨兵 + 关停钩子 + 信号接入；supervisor / cli boot / self-host 共用）
export type { StopSentinelWatchOptions } from "./shutdown.js";
export {
    installSignalShutdown,
    registerShutdownHook,
    removeStopSentinel,
    requestShutdown,
    STOP_SENTINEL_FILENAME,
    stopSentinelPath,
    watchStopSentinel,
    writeStopSentinel,
} from "./shutdown.js";
export type { WinNodeInfo } from "./win-node.js";
export { ensureWinNode, nodeZipUrl, WIN_NODE_DIR_NAME } from "./win-node.js";
export type { SpawnCommand } from "./wine.js";
export { buildSpawnCommand, isLinux, toWinePath, wineBinary } from "./wine.js";
