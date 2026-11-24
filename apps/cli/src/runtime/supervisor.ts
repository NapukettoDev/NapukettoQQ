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
import { configError, EXIT_CONFIG_INVALID, resolveDataRoot } from "@napuketto/kernel";
import { watchStopSentinel, writeStopSentinel } from "@napuketto/loader";
import {
    type CliAccountConfig,
    type CliConfig,
    DEFAULT_RESTART_DELAY_MS,
    parseCliQq,
} from "../config/schema.js";
import { loadCliConfigWithSource } from "../config/store.js";
import {
    effectiveConsoleEnv,
    effectiveConsoleFormat,
    logger,
    resolveCliLogConfig,
} from "../logger.js";
import { forwardLines } from "./lines.js";
import {
    type AccountRuntime,
    killProcessTree,
    patchAccountRuntime,
    readAccountRuntime,
    SUPERVISOR_CHILD_ENV,
    selfArgvFingerprint,
    writeAccountRuntime,
    writeSupervisorRuntime,
} from "./state.js";

/** 退出轮询间隔（毫秒）。 */
const EXIT_POLL_MS = 100;
/** 子进程优雅退出时限（毫秒）：哨兵/信号后子进程自行停止，超时强杀兜底。 */
const FORCE_EXIT_MS = 8000;
/**
 * 短生命周期崩溃阈值（毫秒，issue #144）：运行不足该时长的退出视为「连续秒退」，
 * 重启延迟按 `restartDelayMs * 2^n` 指数退避，避免登录后立刻崩溃时高频循环重登
 * 触发 QQ 风控；稳定运行超过该时长后退避计数清零。
 */
const SHORT_LIVED_CRASH_MS = 30_000;
/** 指数退避延迟上限（毫秒）：连续秒退时单次重启最多等 60s。 */
const MAX_RESTART_DELAY_MS = 60_000;

/**
 * 计算下一次守护重启延迟（issue #144）。
 * @param baseDelayMs 配置的首次重启延迟（restartDelayMs）
 * @param consecutiveFailures 连续短生命周期失败次数（从 1 起）
 */
export function computeRestartDelayMs(baseDelayMs: number, consecutiveFailures: number): number {
    const exponent = Math.max(consecutiveFailures - 1, 0);
    return Math.min(baseDelayMs * 2 ** exponent, MAX_RESTART_DELAY_MS);
}

/** supervisor 选项。 */
export interface SupervisorOptions {
    /** 数据根目录。 */
    dataDir?: string;
    /** 显式账号列表（-q A -q B），优先于主配置 accounts。 */
    qqs?: string[];
    /** stub QQNT.dll 目录（自建宿主 PATH 前置，透传给子进程 --stub-dir）。 */
    stubDir?: string;
    /** QQ 安装路径覆盖（透传给子进程 --qq-path；多账号共用同一份原生文件）。 */
    qqPath?: string;
}

/**
 * 解析账号列表（显式 -q 优先，否则主配置 accounts 过滤启用项）。
 * 显式 -q 在此再次校验格式并拒绝重复：重复 qq 会并发拉起同一账号，后一个
 * 子进程覆盖 ctx.children 的 Map 项，导致实例锁冲突与状态文件互相覆盖。
 */
function resolveAccounts(opts: SupervisorOptions, config: CliConfig): CliAccountConfig[] {
    if (opts.qqs !== undefined && opts.qqs.length > 0) {
        const seen = new Set<string>();
        return opts.qqs.map((qq) => {
            parseCliQq(qq);
            if (seen.has(qq)) {
                throw configError(`-q/--qq 重复指定账号: "${qq}"（每个账号只能出现一次）`);
            }
            seen.add(qq);
            return { qq };
        });
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
    /** QQ 安装路径覆盖（透传给子进程 --qq-path）。 */
    qqPath?: string;
    children: Map<string, ChildProcess>;
    /** 每账号守护重启计数（写 runtime.json 用）。 */
    restartCounts: Map<string, number>;
    /** 每账号连续短生命周期崩溃计数（指数退避用，稳定运行后清零）。 */
    crashCounts: Map<string, number>;
    /** 待执行的重启定时器（stopAll / 空闲收尾时统一 clearTimeout）。 */
    pendingRestarts: Map<string, NodeJS.Timeout>;
    /** 已退出且未重启的账号退出码（空闲收尾据此透传 78）。 */
    exitedCodes: Map<string, number | null>;
    /** 子进程退出 / 重启定时器变化后的收尾检查（无子进程且无待重启 → 结束常驻）。 */
    onSettled: () => void;
    /** 是否已结束常驻（结束后的迟到事件一律忽略）。 */
    isFinished: () => boolean;
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
    forwardLines(stream, (line) => {
        process.stdout.write(prefixEnabled ? `[${uin}] ${line}\n` : `${line}\n`);
    });
}

/** 子进程启动参数（spawn 与 runtime.json cmdline 共用，防两处漂移）。 */
function childArgs(ctx: SupervisorCtx, acct: CliAccountConfig): string[] {
    const args = [ctx.entry, "-q", acct.qq, "--data-dir", ctx.dataRoot];
    if (ctx.stubDir !== undefined) {
        args.push("--stub-dir", ctx.stubDir);
    }
    if (ctx.qqPath !== undefined) {
        args.push("--qq-path", ctx.qqPath);
    }
    return args;
}

/** 托管子进程（boot）命令行参数指纹：树杀前 PID 复用校验用（不含可执行文件）。 */
function childCmdline(ctx: SupervisorCtx, acct: CliAccountConfig): string {
    return childArgs(ctx, acct).join(" ");
}

/** 账号进程退出落 runtime exited（status/stop 消费）。
 * 合并写入：保留受管 boot 已记录的 selfHostPid / selfHostCmdline，不整文件覆盖。 */
function writeAccountExited(
    ctx: SupervisorCtx,
    acct: CliAccountConfig,
    child: ChildProcess,
    exitCode: number | null,
    restartCount: number,
): void {
    const cmdline = childCmdline(ctx, acct);
    const fallback: AccountRuntime = {
        uin: acct.qq,
        pid: child.pid ?? 0,
        startedAt: new Date().toISOString(),
        kind: "supervisor-child",
        status: "exited",
        exitCode,
        restartCount,
        cmdline,
    };
    patchAccountRuntime(
        ctx.dataRoot,
        acct.qq,
        {
            ...(child.pid !== undefined ? { pid: child.pid } : {}),
            status: "exited",
            exitCode,
            restartCount,
        },
        fallback,
    );
}

/**
 * 守护重启编排（issue #144）：短生命周期崩溃按指数退避，稳定运行超过阈值后
 * 计数清零（恢复配置的基础延迟）。日志始终带连续失败次数与下次重启延迟。
 */
function scheduleRestart(
    ctx: SupervisorCtx,
    acct: CliAccountConfig,
    code: number | null,
    signal: NodeJS.Signals | null,
    startedAtMs: number,
    restartCount: number,
): void {
    const uptimeMs = Date.now() - startedAtMs;
    const shortLived = uptimeMs < SHORT_LIVED_CRASH_MS;
    const consecutiveFailures = shortLived ? (ctx.crashCounts.get(acct.qq) ?? 0) + 1 : 0;
    ctx.crashCounts.set(acct.qq, consecutiveFailures);
    const delayMs =
        consecutiveFailures > 0
            ? computeRestartDelayMs(ctx.restartDelayMs, consecutiveFailures)
            : ctx.restartDelayMs;
    const fields = {
        qq: acct.qq,
        code,
        signal: signal ?? "none",
        uptimeMs,
        consecutiveFailures,
        nextDelayMs: delayMs,
    };
    if (shortLived) {
        logger.warn(fields, "账号启动后短时间内退出，指数退避后重启");
    } else {
        logger.info(fields, "账号退出，准备重启");
    }
    ctx.restartCounts.set(acct.qq, restartCount + 1);
    const timer = setTimeout(() => {
        ctx.pendingRestarts.delete(acct.qq);
        startAccount(ctx, acct);
    }, delayMs);
    // 追踪定时器：stopAll 必须清理（否则停止后仍会拉起子进程），空闲收尾也依赖
    // 「无待重启」判定。
    ctx.pendingRestarts.set(acct.qq, timer);
}

/** 账号子进程退出编排：配置失败免重启（78）/ 守护重启 / 落 runtime exited。 */
function handleAccountExit(
    ctx: SupervisorCtx,
    acct: CliAccountConfig,
    child: ChildProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
    startedAtMs: number,
    restartCount: number,
): void {
    if (ctx.isFinished()) {
        return;
    }
    ctx.children.delete(acct.qq);
    logger.info({ qq: acct.qq, code, signal: signal ?? "none" }, "账号退出");
    if (code === EXIT_CONFIG_INVALID) {
        // 配置校验失败（2026-10-25 退出码契约）：配置不修，重启无意义——
        // 不进守护重启，落 runtime exited 供 status 消费。
        logger.error({ qq: acct.qq, code }, "账号因配置校验失败退出（78），不自动重启");
        writeAccountExited(ctx, acct, child, code, restartCount);
        ctx.exitedCodes.set(acct.qq, code);
        ctx.onSettled();
        return;
    }
    if (!ctx.isStopping() && ctx.autoRestart) {
        // 关闭信号到达前无限重试，由 SIGINT/SIGTERM 终止
        scheduleRestart(ctx, acct, code, signal, startedAtMs, restartCount);
        return;
    }
    writeAccountExited(ctx, acct, child, code, restartCount);
    ctx.exitedCodes.set(acct.qq, code);
    ctx.onSettled();
}

/** 启动一个账号子进程（exit 后按 autoRestart 守护重启）。 */
function startAccount(ctx: SupervisorCtx, acct: CliAccountConfig): void {
    if (ctx.isStopping() || ctx.isFinished()) {
        return;
    }
    const restartCount = ctx.restartCounts.get(acct.qq) ?? 0;
    // 新一轮生命周期：清掉上一次退出的记录（空闲收尾只看「当前」退出码）。
    ctx.exitedCodes.delete(acct.qq);
    // 引导细节（2026-10-25 级别重分配）：账号上线由子进程登录日志报告，此处降 debug
    logger.debug({ qq: acct.qq, pid: process.pid, restartCount }, "启动账号");
    const args = childArgs(ctx, acct);
    // stdio 管道化（2026-09-08 T8）：逐行前缀转发（多账号输出可辨别），
    // 替代 inherit——结构化状态（runtime.json：pid/启动时间/重启计数）同步落盘。
    // env：banner 由 supervisor 统一打（每树至多一次），子进程注入 NO_BANNER；
    // 渲染决策（format/colorize）按本进程最终控制台形态传播（子进程 stdout 恒 pipe）；
    // SUPERVISOR_CHILD_ENV 标记托管模式（受管 boot 只合并更新 runtime.json，不覆盖
    // supervisor 写入的 kind/restartCount）。
    const child = spawn(process.execPath, args, {
        stdio: ["inherit", "pipe", "pipe"],
        env: {
            ...process.env,
            NAPUKETTO_NO_BANNER: "1",
            [SUPERVISOR_CHILD_ENV]: "1",
            ...ctx.childEnv,
        },
    });
    // 生命周期起点：exit 时据此判定「秒退」（短生命周期崩溃）还是稳定运行。
    const startedAtMs = Date.now();
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
        cmdline: childCmdline(ctx, acct),
    });
    child.on("exit", (code, signal) => {
        handleAccountExit(ctx, acct, child, code, signal, startedAtMs, restartCount);
    });
    child.on("error", (err) => {
        if (ctx.isFinished()) {
            return;
        }
        const { message } = err;
        logger.error({ qq: acct.qq, err }, `账号启动失败: ${message}`);
        ctx.children.delete(acct.qq);
        ctx.exitedCodes.set(acct.qq, 1);
        ctx.onSettled();
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
    // 待重启定时器必须清理：停止后不能再拉起子进程（否则父进程退出前又 spawn 出孤儿）。
    for (const timer of ctx.pendingRestarts.values()) {
        clearTimeout(timer);
    }
    ctx.pendingRestarts.clear();
    writeStopSentinel(ctx.dataRoot, "all");
    // 超时兜底：子进程不响应（自建宿主卡死等）时强杀残留，父进程不再死等。
    // 强杀覆盖 boot pid + runtime.json 记录的 selfHostPid（POSIX SIGTERM→SIGKILL），
    // 否则只 kill boot 会留下忽略信号的 self-host 孤儿。
    const forceTimer = setTimeout(() => {
        for (const [uin, child] of ctx.children) {
            const pid = child.pid;
            if (pid === undefined) {
                continue;
            }
            const runtime = readAccountRuntime(ctx.dataRoot, uin);
            killProcessTree(pid, {
                ...(runtime?.selfHostPid !== undefined ? { extraPids: [runtime.selfHostPid] } : {}),
                onError: (message) => logger.warn({ uin, message }, "强制停止失败"),
            });
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
    // 内联优先（NAPUKETTO_CONFIG_JSON > 文件）；校验失败 ConfigError → exit 78
    const { config } = await loadCliConfigWithSource({
        ...(opts.dataDir !== undefined ? { dataDir: opts.dataDir } : {}),
        // 日志经回调注入：store 不反向 import logger（config <-> logger 解耦）
        onInfo: (obj, msg) => logger.info(obj, msg),
    });
    const accounts = resolveAccounts(opts, config);
    if (accounts.length === 0) {
        logger.warn("supervisor：没有启用的账号（主配置 accounts 为空或全部禁用）");
        return;
    }
    const restartDelayMs = resolveRestartDelay(opts, config);
    const [, entry = ""] = process.argv;
    const children = new Map<string, ChildProcess>();
    const restartCounts = new Map<string, number>();
    const crashCounts = new Map<string, number>();
    const pendingRestarts = new Map<string, NodeJS.Timeout>();
    const exitedCodes = new Map<string, number | null>();
    let stopping = false;
    let finished = false;
    let resolveResident: (() => void) | undefined;
    // 常驻 promise 必须早于 startAccount 创建：子进程可能在任何 await 之前就退出，
    // 空闲收尾（finish）需要能即时 resolve 它。
    const resident = new Promise<void>((resolve) => {
        resolveResident = resolve;
    });
    const signalHandlers: Array<{ signal: NodeJS.Signals; listener: () => void }> = [];
    /** 结束常驻：清理定时器/信号监听 → 写退出码 → 释放 runSupervisor 的 await。 */
    const finish = (code: number): void => {
        if (finished) {
            return;
        }
        finished = true;
        for (const timer of pendingRestarts.values()) {
            clearTimeout(timer);
        }
        pendingRestarts.clear();
        for (const { signal, listener } of signalHandlers) {
            process.off(signal, listener);
        }
        process.exitCode = code;
        resolveResident?.();
    };
    /**
     * 空闲收尾：既无存活子进程也无待重启定时器时不再常驻。
     * 典型场景：autoRestart=false 且全部子进程退出；全部账号因配置失败（78）退出
     * （不进重启队列）。没有这一步，supervisor 会被信号监听句柄永久挂起，即便
     * 早已没有任何账号在跑。
     */
    const maybeFinish = (): void => {
        if (stopping || finished || children.size > 0 || pendingRestarts.size > 0) {
            return;
        }
        const codes = [...exitedCodes.values()];
        const allConfigInvalid =
            codes.length > 0 && codes.every((code) => code === EXIT_CONFIG_INVALID);
        if (allConfigInvalid) {
            finish(EXIT_CONFIG_INVALID);
            return;
        }
        // 非 78 的异常退出（含信号杀死 code=null）收尾为 1，正常结束为 0。
        finish(codes.some((code) => code !== 0) ? 1 : 0);
    };
    // 渲染决策：按本进程最终控制台形态解析（[log] 配置 + TTY），传播给子进程
    const logCfg = resolveCliLogConfig(opts.dataDir);
    const ctx: SupervisorCtx = {
        dataRoot,
        entry,
        restartDelayMs,
        autoRestart: config.autoRestart,
        ...(opts.stubDir !== undefined ? { stubDir: opts.stubDir } : {}),
        ...(opts.qqPath !== undefined ? { qqPath: opts.qqPath } : {}),
        children,
        restartCounts,
        crashCounts,
        pendingRestarts,
        exitedCodes,
        onSettled: maybeFinish,
        isFinished: () => finished,
        // 入站图片自动下载补丁 killswitch（issue #105）：config.nativeMediaPatch=false
        // 时注入（子进程 -q 直跑继承，launchSelfHost 不再覆盖——同名 env 优先级见 launcher）。
        childEnv: {
            ...effectiveConsoleEnv(logCfg),
            ...(config.nativeMediaPatch === false ? { NAPUTO_DISABLE_MEDIA_PATCH: "1" } : {}),
        },
        prefixEnabled: effectiveConsoleFormat(logCfg) === "pretty",
        isStopping: () => stopping,
    };

    // supervisor 自身状态落盘（napuketto status/stop 消费；cmdline 指纹供 stop 前 PID 复用校验）
    const supervisorCmdline = selfArgvFingerprint();
    writeSupervisorRuntime(dataRoot, {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        accounts: accounts.map((a) => a.qq),
        ...(supervisorCmdline !== undefined ? { cmdline: supervisorCmdline } : {}),
    });

    for (const acct of accounts) {
        startAccount(ctx, acct);
    }

    // 信号转发：停止全部子进程 → 父进程退出。
    // SIGBREAK = Windows CTRL_BREAK_EVENT（嵌入式宿主 CREATE_NEW_PROCESS_GROUP +
    // GenerateConsoleCtrlEvent 可优雅停整树）；另接停止哨兵（宿主/脚本写文件即可）。
    const shutdown = (): void => {
        if (stopping || finished) {
            return;
        }
        stopping = true;
        stopAll(ctx);
    };
    for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) {
        process.on(signal, shutdown);
        signalHandlers.push({ signal, listener: shutdown });
    }
    // supervisor 不持有账号：仅响应 all/空内容哨兵（单账号哨兵由对应 boot/self-host 自行消费）
    watchStopSentinel({ dataRoot, onTrigger: shutdown });

    // 常驻：收到退出信号由 stopAll 的 process.exit 结束；全部子进程退出且无待重启
    // 时由 maybeFinish 结束（返回退出码契约：全 78 → 78，否则 0）。
    await resident;
}
