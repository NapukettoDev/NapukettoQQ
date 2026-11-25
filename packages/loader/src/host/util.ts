/**
 * util.ts：引导公共工具（配置错误契约 + 共享状态）。
 * 2026-08-07 阶段 2：由 runtime/boot-util.js TS 化（零语义改动）。
 * 2026-11-25 分层重构：文件日志下沉 `internal/boot-log.ts`（lifecycle/qq 需要它但
 * 不得反向依赖 host/），本文件只做 re-export 兼容既有调用点；`errMsg` 别名删除，
 * 错误提取统一走 `internal/type-guards.ts#getErrorMessage`。
 * 由 self-host.ts 及各拆分模块 import（CJS bundle，运行在自建宿主引导进程内）。
 */

import { bootLogPath, log, logFatal } from "../internal/boot-log.js";
import { getErrorMessage } from "../internal/type-guards.js";

export { bootLogPath, log, logFatal };

/**
 * 配置校验失败标记错误（2026-10-25 嵌入式退出码契约）。
 * 与 kernel ConfigError 同契约定名（name="ConfigError"）——loader 不静态依赖
 * kernel（运行期动态 import），按错误名复刻判定面：协议段 seed 校验失败与
 * kernel 主配置校验失败同族，bootstrap 链重抛后由 self-host 以 78 退出
 * （宿主据此区分「配置未就绪」与运行时崩溃，免重启）。
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

/**
 * 逐条处理消息回调参数（onRecvMsg 为消息数组——2026-08-07 运行时实证；
 * 兼容单条对象，过滤无效项）。
 */
export function forEachRawMessage(msgs: unknown, handler: (msg: unknown) => void): void {
    const list = Array.isArray(msgs) ? msgs : [msgs];
    for (const msg of list) {
        if (!msg || typeof msg !== "object") {
            continue;
        }
        handler(msg);
    }
}

/** 共享状态（self-host.ts 入口创建，各拆分模块读写）。
 *  - wrapperExports：dlopen 截获的 wrapper.node exports
 *  - qqSession / qqLoginService：Proxy 捕获的 QQ 实例（V1 路线）
 *  - bootstrapped：kernel 引导是否已启动（防重入） */
export interface SharedState {
    wrapperExports: Record<string, unknown> | null;
    qqSession: unknown;
    qqLoginService: unknown;
    bootstrapped: boolean;
}

export function createState(): SharedState {
    return {
        wrapperExports: null,
        qqSession: null,
        qqLoginService: null,
        bootstrapped: false,
    };
}
