/**
 * errors.ts：引导链配置错误契约（退出码 78 的唯一判定来源）。
 *
 * ConfigError 与 kernel 同名同契约（name="ConfigError"）——loader 不静态依赖
 * kernel（运行期动态 import），按错误名复刻判定面：协议段 seed 校验失败与
 * kernel 主配置校验失败同族，bootstrap 链重抛后由 self-host 以 78 退出
 * （宿主据此区分「配置未就绪」与运行时崩溃，免重启）。
 *
 * 分层：`host/runtime/` 是子进程共享基础层，只依赖 `shared/` 与 `contract/`。
 */
import { logFatal } from "../../shared/boot-log.js";
import { getErrorMessage } from "../../shared/type-guards.js";

/**
 * 配置校验失败标记错误（2026-10-25 嵌入式退出码契约）。
 */
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
 * bootstrap 失败收敛（2026-10-25 退出码契约）：配置校验失败（ConfigError 一族）
 * 原样重抛——self-host 据此以 78 退出（宿主免重启），链条上任何 catch 都不得
 * 吞掉；其余失败记日志并收敛 false（引导失败原因见 napuketto-boot.log）。
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
