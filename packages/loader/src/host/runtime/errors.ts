/**
 * errors.ts：引导链配置错误契约（退出码 78 的唯一判定来源）。
 * loader 编译期不依赖 kernel，故按错误名复刻 ConfigError——协议段 seed 校验失败与 kernel 主配置
 * 校验失败同族，重抛后 self-host 以 78 退出（宿主据此区分「配置未就绪」与运行时崩溃，免重启）。
 */
import { logFatal } from "../../shared/boot-log.js";
import { getErrorMessage } from "../../shared/type-guards.js";

/** 配置校验失败标记错误（嵌入式退出码契约）。 */
export class ConfigError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "ConfigError";
    }
}

/** 配置校验失败判定（name 契约：kernel ConfigError 与 loader 复刻类都命中）。 */
export function isConfigError(err: unknown): boolean {
    return err instanceof Error && err.name === "ConfigError";
}

/** bootstrap 失败 → 进程退出码（78 = 配置校验失败一族；1 = 其余运行时失败）。 */
export function bootstrapExitCode(err: unknown): number {
    return isConfigError(err) ? 78 : 1;
}

/**
 * bootstrap 失败收敛（退出码契约）：配置校验失败（ConfigError 一族）原样重抛——
 * self-host 据此以 78 退出（宿主免重启），链条上任何 catch 都不得吞掉；
 * 其余失败记日志并收敛 false（引导失败原因见 napuketto-boot.log）。
 * @param phase 失败阶段标注（日志前缀，如 "lifecycle error" / "import kernel failed"）
 * @returns 恒 false（调用方直接 `return convergeBootstrapFailure(e, ...)`）
 */
export function convergeBootstrapFailure(e: unknown, phase: string): false {
    if (isConfigError(e)) {
        throw e;
    }
    logFatal(`bootstrap: ${phase}: ${getErrorMessage(e)}`);
    return false;
}
