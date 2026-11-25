/**
 * 优雅关停：停止哨兵 + 关停钩子 + 信号接入（supervisor / cli boot / self-host 共用）；退出码契约 0 = 请求式正常退出，非 0 = 引导失败/运行时致命。
 * Windows 下 SIGTERM 投递不到无控制台进程（嵌入式 pipe），只能 taskkill /T /F 树杀且退出码 1 与真实崩溃无法区分——宿主应优先用哨兵通道。
 * 哨兵 `<数据根>/napuketto.stop`：内容空/"all" = 全部、"<uin>" = 单账号；mtime 晚于进程启动才触发（陈旧哨兵不触发），每进程一次，轮询 500ms。
 */

import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { log } from "../shared/boot-log.js";
import { getErrorMessage } from "../shared/type-guards.js";

/** 哨兵文件名（置于数据根）。 */
export const STOP_SENTINEL_FILENAME = "napuketto.stop";
/** 哨兵轮询间隔（毫秒）。 */
const SENTINEL_POLL_MS = 500;

/** 哨兵文件路径。 */
export function stopSentinelPath(dataRoot: string): string {
    return join(dataRoot, STOP_SENTINEL_FILENAME);
}

/**
 * 单账号哨兵文件路径（`<数据根>/napuketto.stop.<uin>`）。
 *
 * 全局哨兵（`napuketto.stop`）是单文件、内容即目标 uin——多个
 * `napuketto stop -q` 并发时会互相覆盖内容、并可能在等待结束后互相删除文件
 * （后完成者把先完成者的请求提前清掉）。单账号目标因此改用独立文件：写入
 * 与清理都只触碰本账号文件，天然并发安全；全局 `all` 仍走原单文件契约。
 */
export function accountStopSentinelPath(dataRoot: string, account: string): string {
    return join(dataRoot, `${STOP_SENTINEL_FILENAME}.${encodeURIComponent(account)}`);
}

/**
 * 写停止哨兵（请求优雅关停）。target = "all"/空 = 全部账号；"<uin>" = 单账号。
 * 任何内容（含空）都视为请求；mtime 由写入时刻决定。
 *
 * 单账号的并发安全通道是 `writeAccountStopSentinel`（独立文件）；本函数保留
 * 单文件 + 内容匹配的既有契约（外部脚本 / 兼容旧调用方），观察方两者都认。
 */
export function writeStopSentinel(dataRoot: string, target: "all" | string): void {
    writeFileSync(stopSentinelPath(dataRoot), target === "all" ? "all\n" : `${target}\n`, "utf8");
}

/** 写单账号停止哨兵（独立文件；并发 `stop -q` 互不覆盖）。 */
export function writeAccountStopSentinel(dataRoot: string, account: string): void {
    // 内容仅供诊断（观察方只看文件存在 + mtime），保持与全局哨兵一致的「uin\n」形态。
    writeFileSync(accountStopSentinelPath(dataRoot, account), `${account}\n`, "utf8");
}

/** 删除文件（不存在/删除失败不阻塞：mtime 守卫使陈旧哨兵天然失效）。 */
function removeIfExists(path: string): void {
    if (!existsSync(path)) {
        return;
    }
    try {
        rmSync(path);
    } catch {
        // 删除失败不阻塞（mtime 守卫使陈旧哨兵天然失效）
    }
}

/** 删除全局停止哨兵（napuketto stop 等待结束后清理，防陈旧文件累积）。 */
export function removeStopSentinel(dataRoot: string): void {
    removeIfExists(stopSentinelPath(dataRoot));
}

/** 删除单账号停止哨兵（只删本账号文件，不动全局与其他账号）。 */
export function removeAccountStopSentinel(dataRoot: string, account: string): void {
    removeIfExists(accountStopSentinelPath(dataRoot, account));
}

/** 哨兵内容是否命中本观察者（all/空 = 全部；否则精确匹配账号）。 */
function sentinelMatches(content: string, account: string | undefined): boolean {
    const trimmed = content.trim();
    if (trimmed === "" || trimmed === "all") {
        return true;
    }
    return account !== undefined && trimmed === account;
}

/** 哨兵观察选项。 */
export interface StopSentinelWatchOptions {
    /** 数据根（哨兵所在目录）。 */
    dataRoot: string;
    /** 本进程对应账号（uin 或 "default"；undefined = 仅响应 all/空）。 */
    account?: string;
    /** 触发回调（每进程至多一次）。 */
    onTrigger: () => void;
    /** 轮询间隔（测试注入用）。 */
    pollMs?: number;
}

/** 读取「新鲜」哨兵内容（存在且 mtime 晚于进程启动）；缺失/陈旧/读写竞态 → null。 */
function readFreshSentinel(path: string, processStartMs: number): string | null {
    try {
        if (!existsSync(path)) {
            return null;
        }
        if (statSync(path).mtimeMs <= processStartMs) {
            return null;
        }
        return readFileSync(path, "utf8");
    } catch {
        // 读写竞态（正在被写/删）：下一轮再看
        return null;
    }
}

/**
 * 观察停止哨兵：全局文件（内容命中）或本账号独立文件（存在即命中）→ onTrigger
 * （一次性）。返回取消函数。mtime 守卫：进程启动前遗留的哨兵不触发（守护重启安全）。
 */
export function watchStopSentinel(opts: StopSentinelWatchOptions): () => void {
    const globalPath = stopSentinelPath(opts.dataRoot);
    const accountPath =
        opts.account !== undefined
            ? accountStopSentinelPath(opts.dataRoot, opts.account)
            : undefined;
    const processStartMs = performance.timeOrigin;
    let triggered = false;
    const timer = setInterval(() => {
        if (triggered) {
            return;
        }
        const globalContent = readFreshSentinel(globalPath, processStartMs);
        if (globalContent !== null && sentinelMatches(globalContent, opts.account)) {
            triggered = true;
            opts.onTrigger();
            return;
        }
        // 单账号独立哨兵：文件存在（mtime 新鲜）即请求，内容不参与匹配。
        if (accountPath !== undefined && readFreshSentinel(accountPath, processStartMs) !== null) {
            triggered = true;
            opts.onTrigger();
        }
    }, opts.pollMs ?? SENTINEL_POLL_MS);
    // 不阻塞进程自然退出
    timer.unref?.();
    return () => {
        triggered = true;
        clearInterval(timer);
    };
}

type ShutdownHook = () => void | Promise<void>;
const SHUTDOWN_PHASES = ["intake", "protocols", "services", "flush"] as const;
type ShutdownPhase = (typeof SHUTDOWN_PHASES)[number];

const HOOK_TIMEOUT_MS = 1500;
const SHUTDOWN_TIMEOUT_MS = 7000;
const hooks: Record<ShutdownPhase, ShutdownHook[]> = {
    intake: [],
    protocols: [],
    services: [],
    flush: [],
};
let shutdown: Promise<void> | undefined;

export function isShuttingDown(): boolean {
    return shutdown !== undefined;
}

/** 在各阶段内按注册逆序清理，默认保留原来的通用钩子语义。 */
export function registerShutdownHook(
    hook: ShutdownHook,
    phase: ShutdownPhase = "services",
): () => void {
    if (isShuttingDown()) {
        return () => undefined;
    }
    const pending = hooks[phase];
    pending.push(hook);
    return () => {
        const index = pending.indexOf(hook);
        if (index !== -1) {
            pending.splice(index, 1);
        }
    };
}

/** 限制单钩子的等待时间。同步阻塞的原生调用由父进程强杀兜底。 */
export async function runShutdownHook(hook: ShutdownHook, phase: ShutdownPhase): Promise<void> {
    const result = hook();
    if (result === undefined) {
        return;
    }
    let timer: NodeJS.Timeout | undefined;
    try {
        await Promise.race([
            result,
            new Promise<void>((resolve) => {
                timer = setTimeout(() => {
                    log(`[self-host] 关停阶段 ${phase} 等待超时`);
                    resolve();
                }, HOOK_TIMEOUT_MS);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

async function drainShutdown(reason: string, exitCode: number): Promise<void> {
    log(`[self-host] 关停：${reason}`);
    const watchdog = setTimeout(() => {
        log("[self-host] 关停超过总时限，强制退出");
        process.exit(exitCode);
    }, SHUTDOWN_TIMEOUT_MS);
    try {
        for (const phase of SHUTDOWN_PHASES) {
            for (const hook of hooks[phase].splice(0).reverse()) {
                try {
                    await runShutdownHook(hook, phase);
                } catch (err) {
                    log(`[self-host] 关停阶段 ${phase} 异常: ${getErrorMessage(err)}`);
                }
            }
        }
    } finally {
        clearTimeout(watchdog);
        process.exit(exitCode);
    }
}

/** 首次请求决定退出码。并发或重入请求共用一次关停。 */
export function requestShutdown(reason: string, exitCode = 0): Promise<void> {
    shutdown ??= Promise.resolve().then(() => drainShutdown(reason, exitCode));
    return shutdown;
}

/**
 * 信号接入（SIGINT/SIGTERM/SIGBREAK → requestShutdown）。
 * Windows CTRL_BREAK_EVENT 以 SIGBREAK 到达（宿主 CREATE_NEW_PROCESS_GROUP +
 * GenerateConsoleCtrlEvent 可优雅停整树）；终端 Ctrl+C 以 SIGINT 到达。
 */
export function installSignalShutdown(): () => void {
    const onSigint = (): void => {
        void requestShutdown("信号 SIGINT");
    };
    const onSigterm = (): void => {
        void requestShutdown("信号 SIGTERM");
    };
    const onSigbreak = (): void => {
        void requestShutdown("信号 SIGBREAK");
    };
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    process.on("SIGBREAK", onSigbreak);
    // 返回退订函数：重复安装不会污染宿主信号表（嵌入式场景必须可撤销）。
    return () => {
        process.off("SIGINT", onSigint);
        process.off("SIGTERM", onSigterm);
        process.off("SIGBREAK", onSigbreak);
    };
}
