/**
 * CLI 动作错误出口（2026-10-25 退出码契约）：
 *   0 = 请求式优雅关停（0.2.0 已有，不经此路径）；78 = 配置校验失败
 *   （ConfigError 一族，宿主据此区分「配置未就绪」与运行时崩溃，免重启）；
 *   其余 = 1（运行时崩溃，现状不变）。
 *
 * 退出码只认错误类型（instanceof ConfigError），与日志文案完全解耦——
 * 文案是人读的，退出码是宿主消费的机器契约。
 */
import process from "node:process";
import { ConfigError, EXIT_CONFIG_INVALID } from "@napuketto/kernel";
import { logger } from "./logger.js";

/** 统一错误输出（结构化日志，错误对象经 pino serializer 带堆栈）。 */
function reportError(err: unknown): void {
    let message = String(err);
    if (err instanceof Error) {
        const { message: errMessage } = err;
        message = errMessage;
    }
    logger.error({ err }, message);
}

/** 统一 catch 出口：打印错误并按类型设置进程退出码（78 = 配置校验失败）。 */
export function handleActionError(err: unknown): void {
    reportError(err);
    process.exitCode = err instanceof ConfigError ? EXIT_CONFIG_INVALID : 1;
}
