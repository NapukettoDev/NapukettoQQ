/**
 * 日志子域公共出口（ADR-007）
 *
 * logger（pino 封装）/ log-config（[log] 段解析）/ log-format（控制台渲染流）/
 * log-redaction（凭据脱敏，仅 logger 内部消费，不对外暴露）。
 */
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
