/**
 * supervisor：多账号子进程编排（P6，2026-08-05；2026-08-07 自建宿主唯一）
 *
 * 多账号走多进程（ADR-015）：每账号一个独立子进程（node <入口> -q <uin>
 * --data-dir <dataRoot> [--stub-dir <dir>]，复用单账号 runSingleAccount 零改动），
 * 本模块作为父进程：
 *   - 拉起：主配置 accounts（supervisor 子命令）或显式 -q 列表
 *   - 守护：账号异常退出且 autoRestart → 延迟重启
 *   - 信号转发：SIGINT/SIGTERM → 停止全部子进程 → 父进程退出
 */
import { type ChildProcess, spawn } from "node:child_process";
import process from "node:process";
import { createInterface } from "node:readline";
import { EXIT_CONFIG_INVALID, resolveDataRoot } from "@napuketto/kernel";
import { watchStopSentinel, writeStopSentinel } from "@napuketto/loader";
import type { CliAccountConfig, CliConfig } from "../config/schema.js";
import { loadCliConfigWithSource } from "../config/store.js";
import {
    effectiveConsoleEnv,
    effectiveConsoleFormat,
    logger,
    resolveCliLogConfig,
} from "../logger.js";
import { writeAccountRuntime, writeSupervisorRuntime } from "./state.js";

/** 默认重启延迟（毫秒）。 */
const DEFAULT_RESTART_DELAY_MS = 2000;
/** 退出轮询间隔（毫秒）。 */
const EXIT_POLL_MS = 100;
/** 子进程优雅退出时限（毫秒）：哨兵/信号后子进程自行停止，超时强杀兜底。 */
const FORCE_EXIT_MS = 8000;

/** supervisor 选项。 */
export interface SupervisorOptions {
    /** 数据根目录。 */
    dataDir?: string;
    /** 显式账号列表（-q A -q B），优先于主配置 accounts。 */
    qqs?: string[];
    /** stub QQNT.dll 目录（自建宿主 PATH 前置，透传给子进程 --stub-dir）。 */
    stubDir?: string;
}

/** 解析账号列表（显式 -q 优先，否则主配置 accounts 过滤启用项）。 */
function resolveAccounts(opts: SupervisorOptions, config: CliConfig): CliAccountConfig[] {
    if (opts.qqs !== undefined && opts.qqs.length > 0) {
        return opts.qqs.map((qq) => ({ qq }));
    }
    return config.accounts.filter((acct) => acct.enabled !== false);
}

/** 解析重启延迟（显式 -q 用默认，主配置场景用配置值）。 */
function resolveRestartDelay(opts: SupervisorOptions, config: CliConfig): number {
    if (opts.qqs === undefined) {
        return config.restartDelayMs;
    }
    return DEFAULT_RESTART_DELAY_MS;
}

/** 监督上下文（startAccount / stopAll 共享，避免闭包过长）。 */
interface SupervisorCtx {
    dataRoot: string;
    entry: string;
    restartDelayMs: number;
    autoRestart: boolean;
    stubDir?: string;
    children: Map<string, ChildProcess>;
    /** 每账号守护重启计数（写 runtime.json 用）。 */
    restartCounts: Map<string, number>;
    /** 子进程追加 env（NO_BANNER + 渲染决策传播）。 */
    childEnv: Record<string, string>;
    /** pretty 模式才加 [uin] 前缀转发（single-line/json 记录自带 account 字段）。 */
    prefixEnabled: boolean;
    isStopping: () => boolean;
}

/**
 * 子进程输出前缀转发（stdout/stderr 逐行）：pretty 模式加 `[uin] ` 前缀
 * （pino 行结构化保留在行内）；single-line/json 模式记录自身已带结构化
 * account 字段（json 加前缀会破坏逐行 JSON.parse），原样透传。
 */
function forwardPrefixed(
    stream: NodeJS.ReadableStream | null,
    uin: string,
    prefixEnabled: boolean,
): void {
    if (stream === null) {
        return;
    }
    const rl = createInterface({ input: stream });
    rl.on("line", (line) => {
        process.stdout.write(prefixEnabled ? `[${uin}] ${line}\n` : `${line}\n`);
    });
}

/** 启动一个账号子进程（exit 后按 autoRestart 守护重启）。 */
function startAccount(ctx: SupervisorCtx, acct: CliAccountConfig): void {
    if (ctx.isStopping()) {
        return;
    }
    const restartCount = ctx.restartCounts.get(acct.qq) ?? 0;
    // 引导细节（2026-10-25 级别重分配）：账号上线由子进程登录日志报告，此处降 debug
    logger.debug({ qq: acct.qq, pid: process.pid, restartCount }, "启动账号");
    const args = [ctx.entry, "-q", acct.qq, "--data-dir", ctx.dataRoot];
    if (ctx.stubDir !== undefined) {
        args.push("--stub-dir", ctx.stubDir);
    }
    // stdio 管道化（2026-09-08 T8）：逐行前缀转发（多账号输出可辨别），
    // 替代 inherit——结构化状态（runtime.json：pid/启动时间/重启计数）同步落盘。
    // env：banner 由 supervisor 统一打（每树至多一次），子进程注入 NO_BANNER；
    // 渲染决策（format/colorize）按本进程最终控制台形态传播（子进程 stdout 恒 pipe）。
    const child = spawn(process.execPath, args, {
        stdio: ["inherit", "pipe", "pipe"],
        env: {
            ...process.env,
            NAPUKETTO_NO_BANNER: "1",
            ...ctx.childEnv,
        },
    });
    forwardPrefixed(child.stdout, acct.qq, ctx.prefixEnabled);
    forwardPrefixed(child.stderr, acct.qq, ctx.prefixEnabled);
    ctx.children.set(acct.qq, child);
    writeAccountRuntime(ctx.dataRoot, {
        uin: acct.qq,
        pid: child.pid ?? 0,
        startedAt: new Date().toISOString(),
        kind: "supervisor-child",
        status: "running",
        restartCount,
    });
    child.on("exit", (code, signal) => {
        ctx.children.delete(acct.qq);
        logger.info({ qq: acct.qq, code, signal: signal ?? "none" }, "账号退出");
        if (code === EXIT_CONFIG_INVALID) {
            // 配置校验失败（2026-10-25 退出码契约）：配置不修，重启无意义——
            // 不进守护重启，落 runtime exited 供 status 消费。
            logger.error({ qq: acct.qq, code }, "账号因配置校验失败退出（78），不自动重启");
            writeAccountRuntime(ctx.dataRoot, {
                uin: acct.qq,
                pid: child.pid ?? 0,
                startedAt: new Date().toISOString(),
                kind: "supervisor-child",
                status: "exited",
                exitCode: code,
                restartCount,
            });
            return;
        }
        if (!ctx.isStopping() && ctx.autoRestart) {
            // 守护：延迟重启（关闭信号到达前无限重试，由 SIGINT/SIGTERM 终止）
            ctx.restartCounts.set(acct.qq, restartCount + 1);
            setTimeout(() => {
                startAccount(ctx, acct);
            }, ctx.restartDelayMs);
        } else {
            writeAccountRuntime(ctx.dataRoot, {
                uin: acct.qq,
                pid: child.pid ?? 0,
                startedAt: new Date().toISOString(),
                kind: "supervisor-child",
                status: "exited",
                exitCode: code,
                restartCount,
            });
        }
    });
    child.on("error", (err) => {
        const { message } = err;
        logger.error({ qq: acct.qq, err }, `账号启动失败: ${message}`);
        ctx.children.delete(acct.qq);
    });
}

/** 停止全部子进程，全部退出后父进程退出（2026-10-25 优雅化）。
 *
 * 优雅路径：写停止哨兵（all）→ 子进程链（boot / self-host）自行有序退出 →
 * 全部退出后 exit 0（退出码契约：0 = 请求式正常退出）。超时（FORCE_EXIT_MS）
 * 未退的子进程 kill 兜底（Windows 下为硬杀）后仍 exit 0——关停请求本身是正常路径，
 * 与崩溃（非 0）区分是契约的核心目标。
 */
function stopAll(ctx: SupervisorCtx): void {
    logger.info("收到退出信号，停止全部账号");
    writeStopSentinel(ctx.dataRoot, "all");
    // 超时兜底：子进程不响应（自建宿主卡死等）时强杀残留，父进程不再死等
    const forceTimer = setTimeout(() => {
        for (const child of ctx.children.values()) {
            child.kill();
        }
        process.exit(0);
    }, FORCE_EXIT_MS);
    forceTimer.unref?.();
    const wait = setInterval(() => {
        if (ctx.children.size === 0) {
            clearInterval(wait);
            clearTimeout(forceTimer);
            process.exit(0);
        }
    }, EXIT_POLL_MS);
}

/** 运行 supervisor（多账号编排）。 */
export async function runSupervisor(opts: SupervisorOptions = {}): Promise<void> {
    const dataRoot = resolveDataRoot(opts.dataDir);
    // 内联优先（NAPKETTO_CONFIG_JSON > 文件）；校验失败 ConfigError → exit 78
    const { config } = await loadCliConfigWithSource(
        opts.dataDir !== undefined ? { dataDir: opts.dataDir } : {},
    );
    const accounts = resolveAccounts(opts, config);
    if (accounts.length === 0) {
        logger.warn("supervisor：没有启用的账号（主配置 accounts 为空或全部禁用）");
        return;
    }
    const restartDelayMs = resolveRestartDelay(opts, config);
    const [, entry = ""] = process.argv;
    const children = new Map<string, ChildProcess>();
    const restartCounts = new Map<string, number>();
    let stopping = false;
    // 渲染决策：按本进程最终控制台形态解析（[log] 配置 + TTY），传播给子进程
    const logCfg = resolveCliLogConfig(opts.dataDir);
    const ctx: SupervisorCtx = {
        dataRoot,
        entry,
        restartDelayMs,
        autoRestart: config.autoRestart,
        ...(opts.stubDir !== undefined ? { stubDir: opts.stubDir } : {}),
        children,
        restartCounts,
        childEnv: effectiveConsoleEnv(logCfg),
        prefixEnabled: effectiveConsoleFormat(logCfg) === "pretty",
        isStopping: () => stopping,
    };

    // supervisor 自身状态落盘（napuketto status/stop 消费）
    writeSupervisorRuntime(dataRoot, {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        accounts: accounts.map((a) => a.qq),
    });

    for (const acct of accounts) {
        startAccount(ctx, acct);
    }

    // 信号转发：停止全部子进程 → 父进程退出。
    // SIGBREAK = Windows CTRL_BREAK_EVENT（嵌入式宿主 CREATE_NEW_PROCESS_GROUP +
    // GenerateConsoleCtrlEvent 可优雅停整树）；另接停止哨兵（宿主/脚本写文件即可）。
    const shutdown = (): void => {
        if (stopping) {
            return;
        }
        stopping = true;
        stopAll(ctx);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    process.on("SIGBREAK", shutdown);
    // supervisor 不持有账号：仅响应 all/空内容哨兵（单账号哨兵由对应 boot/self-host 自行消费）
    watchStopSentinel({ dataRoot, onTrigger: shutdown });

    // 常驻：直到收到退出信号（stopAll 内 process.exit）
    await new Promise<void>(() => {
        // 永不 resolve，由 stopAll 的 process.exit 结束进程
    });
}
