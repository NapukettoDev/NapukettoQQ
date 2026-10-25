/**
 * ops.ts：status / stop / restart 运维命令实现（2026-09-08 T8）。
 *
 * 数据源：runtime/state 状态文件（supervisor/单账号 boot 写入）+ liveness 检测。
 * stop/restart 语义（2026-10-25 优雅化）：
 *  - stop -q <uin>：写单账号停止哨兵 → 等该账号进程链优雅退出 → 超时树杀兜底。
 *    ⚠️ supervisor 在跑且 autoRestart 时账号会被自动拉起——提示用户先 `napuketto stop`。
 *  - stop（无 -q）：写 all 哨兵（supervisor + 全部账号优雅退出）→ 超时树杀兜底。
 *  - restart：stop 同目标 + detached 重新拉起（-q → 单账号 boot；无 -q →
 *    supervisor autoStart）。
 */
import process from "node:process";
import { removeStopSentinel, writeStopSentinel } from "@napuketto/loader";
import { logger } from "../logger.js";
import {
    type AccountRuntime,
    aggregateStatus,
    isPidAlive,
    killProcessTree,
    listAccountRuntimes,
    readSupervisorRuntime,
    spawnDetached,
} from "../runtime/state.js";

/** 运维命令选项。 */
export interface OpsOptions {
    dataDir?: string;
    /** 目标账号（stop/restart 指定；status 过滤）。 */
    qq?: string;
}

/** 优雅停等待上限（毫秒）：哨兵后子进程链自行退出，超时树杀兜底。 */
const GRACEFUL_STOP_WAIT_MS = 8000;
/** 存活轮询间隔（毫秒）。 */
const LIVENESS_POLL_MS = 200;

/** 等待 pid 列表全部退出（返回超时仍未退的 pid）。 */
async function waitForPidsExit(pids: number[]): Promise<number[]> {
    const deadline = Date.now() + GRACEFUL_STOP_WAIT_MS;
    let alive = pids.filter((pid) => pid > 0 && isPidAlive(pid));
    while (alive.length > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, LIVENESS_POLL_MS));
        alive = alive.filter((pid) => isPidAlive(pid));
    }
    return alive;
}

/** status：聚合输出各账号运行状态（含 supervisor 自身）。 */
export function cmdStatus(dataRoot: string, opts: OpsOptions): void {
    const supervisor = readSupervisorRuntime(dataRoot);
    if (supervisor !== null) {
        logger.info(
            {
                pid: supervisor.pid,
                alive: isPidAlive(supervisor.pid),
                accounts: supervisor.accounts,
                startedAt: supervisor.startedAt,
            },
            "supervisor",
        );
    } else {
        logger.info("supervisor 未运行（无状态文件）");
    }
    const runtimes = listAccountRuntimes(dataRoot).filter(
        (r) => opts.qq === undefined || r.uin === opts.qq,
    );
    if (runtimes.length === 0) {
        logger.warn({ dataRoot }, "没有账号运行时状态（从未启动或数据根不含 runtime.json）");
        return;
    }
    for (const row of aggregateStatus(runtimes)) {
        logger.info(
            {
                uin: row.uin,
                alive: row.alive,
                pid: row.pid,
                kind: row.kind,
                startedAt: row.startedAt,
                restartCount: row.restartCount,
                ...(row.exitCode !== undefined ? { exitCode: row.exitCode } : {}),
            },
            "账号状态",
        );
    }
}

/** 树杀目标账号（按 runtime pid）。 */
function stopAccount(runtime: AccountRuntime): void {
    killProcessTree(runtime.pid);
    logger.info({ uin: runtime.uin, pid: runtime.pid }, "已发送停止（树杀）");
}

/** stop：-q 停单账号；无 -q 停 supervisor + 全部账号兜底。
 *
 * 2026-10-25 优雅化：先写停止哨兵（目标账号或 all）→ 等进程链自行有序退出
 * （退出码 0）→ 超时残留树杀兜底 → 清理哨兵。单账号哨兵只命中对应 boot/self-host，
 * 不干扰同数据根的其他账号。
 */
/** stop -q：写单账号哨兵 → 等优雅退出 → 超时树杀兜底 → 清哨兵。 */
async function stopSingleAccount(dataRoot: string, target: AccountRuntime): Promise<void> {
    logger.info({ uin: target.uin, pid: target.pid }, "已发送停止请求（哨兵），等待退出");
    writeStopSentinel(dataRoot, target.uin);
    const stragglers = await waitForPidsExit([target.pid]);
    for (const pid of stragglers) {
        logger.warn({ uin: target.uin, pid }, "限时内未退出，树杀兜底");
        killProcessTree(pid);
    }
    removeStopSentinel(dataRoot);
    const supervisor = readSupervisorRuntime(dataRoot);
    if (supervisor !== null) {
        logger.warn(
            { supervisorPid: supervisor.pid },
            "supervisor 仍在运行且 autoRestart 开启时会自动拉起该账号；如需彻底停止请执行 napuketto stop（停 supervisor）",
        );
    }
}

export async function cmdStop(dataRoot: string, opts: OpsOptions): Promise<void> {
    const runtimes = listAccountRuntimes(dataRoot);
    if (opts.qq !== undefined) {
        const target = runtimes.find((r) => r.uin === opts.qq);
        if (target === undefined) {
            logger.error({ uin: opts.qq }, "账号无运行时状态（未启动过）");
            process.exitCode = 1;
            return;
        }
        await stopSingleAccount(dataRoot, target);
        return;
    }
    const supervisor = readSupervisorRuntime(dataRoot);
    const supervisorPid = supervisor !== null && isPidAlive(supervisor.pid) ? supervisor.pid : 0;
    if (supervisor !== null) {
        logger.info({ pid: supervisor.pid }, "已发送停止请求（哨兵），等待 supervisor 退出");
        writeStopSentinel(dataRoot, "all");
        const alive = await waitForPidsExit([supervisorPid]);
        for (const pid of alive) {
            logger.warn({ pid }, "supervisor 限时内未退出，树杀兜底");
            killProcessTree(pid);
        }
    } else {
        logger.warn("supervisor 未运行（无状态文件）");
    }
    // 兜底：残留账号进程逐个树杀（哨兵转发失败的场合）
    const stragglers = await waitForPidsExit(runtimes.map((r) => r.pid));
    for (const runtime of runtimes) {
        if (stragglers.includes(runtime.pid)) {
            stopAccount(runtime);
        }
    }
    removeStopSentinel(dataRoot);
}

/** restart：stop 同目标 + detached 拉起。 */
export async function cmdRestart(dataRoot: string, opts: OpsOptions): Promise<void> {
    await cmdStop(dataRoot, opts);
    // 等待进程树退出（实例锁：同账号数据目录单实例，立即拉起会抢锁失败）
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const entry = process.argv[1] ?? "";
    const args =
        opts.qq !== undefined
            ? [entry, "-q", opts.qq, "--data-dir", dataRoot]
            : [entry, "--data-dir", dataRoot];
    spawnDetached(args);
    logger.info(
        { args: args.slice(1), qq: opts.qq ?? "(supervisor 全量)" },
        "已 detached 拉起（日志不再接入当前终端，见数据目录 logs/）",
    );
}
