/**
 * util.ts：引导公共工具（日志 + 共享状态）。
 * 2026-08-07 阶段 2：由 runtime/boot-util.js TS 化（零语义改动）。
 * 由 self-host.ts 及各拆分模块 import（CJS bundle，运行在自建宿主引导进程内）。
 */
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "./env.js";

/** boot 日志路径（NAPUTO_CFG_DIR 下，与 stub 验证日志同目录）。 */
const LOG_PATH = env.NAPUTO_CFG_DIR
    ? join(env.NAPUTO_CFG_DIR, "napuketto-boot.log")
    : join(tmpdir(), "napuketto-boot.log");

/** 追加一行 boot 日志（失败静默，不阻塞引导）。 */
export function log(msg: string): void {
    try {
        appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`);
    } catch {
        // ignore
    }
}

/** 错误信息提取（保留 JS 原语义：message 存在用 message，否则用错误对象本身）。 */
export function errMsg(e: unknown): string {
    return `${(e as { message?: unknown } | null | undefined)?.message ?? e}`;
}

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
