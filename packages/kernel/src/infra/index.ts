/**
 * kernel 基础设施层公共出口（ADR-007/009/012/016）
 *
 * 错误 / 路径 / 日志 / 配置四件套。全 kernel 层共享，最底层——
 * 禁止反向依赖 native / apis / runtime 等上层模块（依赖方向硬约束）。
 */
export type { ConfigFormat, ConfigOptions, ConfigSchema } from "./config.js";
export { CONFIG_FILE_MODE, ConfigBase, parseToml, stringifyToml } from "./config.js";
export type { KernelErrorCode } from "./errors.js";
export {
    ConfigError,
    configError,
    EXIT_CONFIG_INVALID,
    errorMessage,
    isKernelError,
    KERNEL_ERROR_CODES,
    KernelError,
    kernelError,
} from "./errors.js";
export type { ListenerEvents } from "./event-channel.js";
export { NTEventChannel } from "./event-channel.js";
export type {
    ConsoleFormatStreamOptions,
    LogConfig,
    LogEnvSource,
    LogFileConfig,
    LogFormat,
    LoggerOptions,
    LogLevel,
    LogModuleName,
    TimestampMode,
} from "./logging/index.js";
export { createConsoleFormatStream, createLogger, parseLogConfig } from "./logging/index.js";
export type { ConfigPathOptions, PathOptions } from "./paths.js";
export {
    DEFAULT_DATA_ROOT_NAME,
    MAIN_CONFIG_FILE,
    PathWrapper,
    resolveConfigPath,
    resolveDataRoot,
    resolveSandboxWritePath,
} from "./paths.js";
export {
    getErrorCode,
    getErrorMessage,
    getOwnProp,
    hasBooleanProp,
    hasCallableProp,
    hasFunctionProp,
    hasMethodSurface,
    hasNullableNumberProp,
    hasNullableStringProp,
    hasNumberProp,
    hasOptionalStringProp,
    hasStaticCreator,
    hasStaticGetter,
    hasStringProp,
    isCallable,
    isPromiseLike,
    isRecord,
    parseJsonWithGuard,
    requireKernelService,
} from "./type-guards.js";
export { raceWithTimeout, sleep, waitFor } from "./wait.js";
