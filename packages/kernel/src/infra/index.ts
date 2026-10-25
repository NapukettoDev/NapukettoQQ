/**
 * kernel 基础设施层公共出口（ADR-007/009/012/016）
 *
 * 错误 / 路径 / 日志 / 配置四件套。全 kernel 层共享，最底层——
 * 禁止反向依赖 apis / bridge / core 等业务模块（依赖方向硬约束）。
 */
export type { ConfigFormat, ConfigOptions, ConfigSchema } from "./config.js";
export { ConfigBase, parseToml, stringifyToml } from "./config.js";
export type { KernelErrorCode } from "./errors.js";
export {
    ConfigError,
    configError,
    EXIT_CONFIG_INVALID,
    isKernelError,
    KERNEL_ERROR_CODES,
    KernelError,
    kernelError,
} from "./errors.js";
export type {
    LogConfig,
    LogEnvSource,
    LogFileConfig,
    LogFormat,
    LogModuleName,
    TimestampMode,
} from "./log-config.js";
export { parseLogConfig } from "./log-config.js";
export type { ConsoleFormatStreamOptions } from "./log-format.js";
export { createConsoleFormatStream } from "./log-format.js";
export type { LoggerOptions, LogLevel } from "./logger.js";
export { createLogger } from "./logger.js";
export type { ConfigPathOptions, PathOptions } from "./paths.js";
export {
    DEFAULT_DATA_ROOT_NAME,
    MAIN_CONFIG_FILE,
    PathWrapper,
    resolveConfigPath,
    resolveDataRoot,
} from "./paths.js";
