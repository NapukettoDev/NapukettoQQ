/**
 * CLI 动作错误出口（2026-10-25 退出码契约；2026-11 预期错误去堆栈）：
 *   0 = 请求式优雅关停（0.2.0 已有，不经此路径）；78 = 配置校验失败
 *   （ConfigError 一族，宿主据此区分「配置未就绪」与运行时崩溃，免重启）；
 *   其余 = 1（运行时崩溃，现状不变）。
 *
 * 退出码只认错误类型（instanceof ConfigError），与日志文案完全解耦——
 * 文案是人读的，退出码是宿主消费的机器契约。
 *
 * 日志分两档：
 *   - 预期内用户错误（ConfigError / KernelError INVALID_PARAM）：消息链拼成单行，
 *     只带 errorType/code 轻量字段，不在默认级别打印堆栈；
 *   - 预期外错误：保持 { err } 结构化输出（pino serializer 展开堆栈）。
 *   两档都保留 logger.debug({ err }) 的完整堆栈，排障不降级。
 */
import process from "node:process";
import {
    ConfigError,
    EXIT_CONFIG_INVALID,
    errorMessage,
    isKernelError,
    type KernelError,
} from "@napuketto/kernel";
import { logger } from "../logger.js";

/** 消息链最大深度（防御异常 cause 环与超长链）。 */
const MAX_CAUSE_DEPTH = 8;

/**
 * 预期内用户错误：配置未就绪（ConfigError）或参数非法（INVALID_PARAM）。
 * ConfigError 本身就是 code=INVALID_PARAM 的 KernelError 子型，这里显式分开写，
 * 让「配置失败」与「参数非法」两类预期语义在分类处可见。
 */
function isExpectedUserError(err: unknown): err is KernelError {
    return err instanceof ConfigError || (isKernelError(err) && err.code === "INVALID_PARAM");
}

/**
 * 把 `err.message → cause.message → ...` 拼成单行提示：预期错误的文案本身就是
 * 结论（哪份配置、哪个字段、怎么改），比默认级别的堆栈更直接。换行折叠为空格
 * 保证单行；cause 环按已见对象截断。
 */
function errorChainText(err: unknown): string {
    const parts: string[] = [];
    const seen = new Set<unknown>();
    let current: unknown = err;
    while (current !== undefined && current !== null && parts.length < MAX_CAUSE_DEPTH) {
        if (seen.has(current)) {
            break;
        }
        seen.add(current);
        const text = errorMessage(current).replace(/\s+/g, " ").trim();
        if (text !== "") {
            parts.push(text);
        }
        current = current instanceof Error ? current.cause : undefined;
    }
    return parts.join(" — ");
}

/** 统一错误输出（预期错误单行 + debug 堆栈；预期外错误保持结构化 err）。 */
function reportError(err: unknown): void {
    if (isExpectedUserError(err)) {
        logger.error({ errorType: err.name, code: err.code }, errorChainText(err));
        logger.debug({ err }, "详细错误堆栈");
        return;
    }
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
