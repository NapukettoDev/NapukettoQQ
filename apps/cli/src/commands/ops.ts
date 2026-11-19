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
import {
    removeAccountStopSentinel,
    removeStopSentinel,
    writeAccountStopSentinel,
    writeStopSentinel,
} from "@napuketto/loader";
import { parseCliQq } from "../config/schema.js";
import { logger } from "../logger.js";
import {
    type AccountRuntime,
    aggregateStatus,
    checkProcessIdentity,
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

/**
 * 运维命令 `-q` 入口校验（复用主配置 QQ 规则）：非法值抛 ConfigError（exit 78），
 * 避免 `-q all` 命中全局停止哨兵或 `-q ../..` 拼出数据根之外的路径。
 */
function assertOpsQq(opts: OpsOptions): void {
    if (opts.qq !== undefined) {
        parseCliQq(opts.qq);
    }
}

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
    assertOpsQq(opts);
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
                ...(row.selfHostPid !== undefined ? { selfHostPid: row.selfHostPid } : {}),
                kind: row.kind,
                startedAt: row.startedAt,
                restartCount: row.restartCount,
                ...(row.exitCode !== undefined ? { exitCode: row.exitCode } : {}),
            },
            "账号状态",
        );
    }
}

/**
 * 树杀前 PID 身份校验（防 PID 复用误杀，口径同 loader `checkInstanceLock`）：
 * mismatch 直接跳过；unverified（旧状态无 cmdline 摘要 / 平台不支持探针）默认沿用
 * 旧行为并记 debug，`allowUnverified: false` 时拒绝（调用方无法证明 pid 身份）。
 */
function canKillProcess(
    pid: number,
    cmdline: string | undefined,
    fields: Record<string, unknown>,
    options: { allowUnverified?: boolean } = {},
): boolean {
    const identity = checkProcessIdentity(pid, cmdline);
    if (identity === "mismatch") {
        logger.warn({ ...fields, pid }, "PID 已被无关进程复用（命令行不匹配），跳过树杀以避免误杀");
        return false;
    }
    if (identity === "unverified") {
        if (options.allowUnverified === false) {
            logger.warn(
                { ...fields, pid },
                "缺少命令行指纹且无同树存活进程可佐证，跳过树杀以避免误杀",
            );
            return false;
        }
        logger.debug({ ...fields, pid }, "无命令行摘要，未做 PID 复用校验");
    }
    return true;
}

/** 树杀目标账号：boot pid + selfHostPid 分别做存活/身份校验后一并强杀。 */
function killAccountTree(runtime: AccountRuntime): void {
    const targets: number[] = [];
    // boot 是 self-host 的父进程：boot 已验证存活时，旧状态无 self-host 指纹也可
    // 认为该 pid 仍是本树子进程；boot 已死时必须依赖 self-host 自身指纹，否则
    // 可能误杀被复用的无关 pid。
    const bootKillable =
        isPidAlive(runtime.pid) &&
        canKillProcess(runtime.pid, runtime.cmdline, { uin: runtime.uin });
    if (bootKillable) {
        targets.push(runtime.pid);
    }
    const selfHostPid = runtime.selfHostPid;
    if (
        selfHostPid !== undefined &&
        isPidAlive(selfHostPid) &&
        canKillProcess(
            selfHostPid,
            runtime.selfHostCmdline,
            { uin: runtime.uin, role: "self-host" },
            { allowUnverified: bootKillable },
        )
    ) {
        targets.push(selfHostPid);
    }
    const [primary] = targets;
    if (primary === undefined) {
        logger.warn(
            { uin: runtime.uin, pid: runtime.pid },
            "无可安全结束的进程（已退出或 PID 已复用），跳过树杀",
        );
        return;
    }
    killProcessTree(primary, {
        extraPids: targets.slice(1),
        onError: (message) => logger.warn({ uin: runtime.uin, message }, "树杀失败"),
    });
    logger.info({ uin: runtime.uin, pids: targets }, "已发送停止（树杀）");
}

/** stop：-q 停单账号；无 -q 停 supervisor + 全部账号兜底。
 *
 * 2026-10-25 优雅化：先写停止哨兵（目标账号或 all）→ 等进程链自行有序退出
 * （退出码 0）→ 超时残留树杀兜底 → 清理哨兵。单账号哨兵只命中对应 boot/self-host，
 * 不干扰同数据根的其他账号。
 */
/** stop -q：写单账号独立哨兵 → 等优雅退出 → 超时树杀兜底 → 清本账号哨兵。 */
async function stopSingleAccount(dataRoot: string, target: AccountRuntime): Promise<void> {
    logger.info({ uin: target.uin, pid: target.pid }, "已发送停止请求（哨兵），等待退出");
    // 独立文件：并发 stop -q 不同账号时互不覆盖，也不会提前删除对方的请求。
    writeAccountStopSentinel(dataRoot, target.uin);
    const trackedPids = [
        target.pid,
        ...(target.selfHostPid !== undefined ? [target.selfHostPid] : []),
    ];
    const stragglers = await waitForPidsExit(trackedPids);
    if (stragglers.length > 0) {
        logger.warn({ uin: target.uin, pids: stragglers }, "限时内未退出，树杀兜底");
        killAccountTree(target);
    }
    removeAccountStopSentinel(dataRoot, target.uin);
    const supervisor = readSupervisorRuntime(dataRoot);
    if (supervisor !== null) {
        logger.warn(
            { supervisorPid: supervisor.pid },
            "supervisor 仍在运行且 autoRestart 开启时会自动拉起该账号；如需彻底停止请执行 napuketto stop（停 supervisor）",
        );
    }
}

/** 全量 stop：停 supervisor（all 哨兵 → 超时树杀，含 PID 复用校验）。 */
async function stopSupervisor(dataRoot: string): Promise<void> {
    const supervisor = readSupervisorRuntime(dataRoot);
    if (supervisor === null) {
        logger.warn("supervisor 未运行（无状态文件）");
        return;
    }
    const supervisorPid = isPidAlive(supervisor.pid) ? supervisor.pid : 0;
    logger.info({ pid: supervisor.pid }, "已发送停止请求（哨兵），等待 supervisor 退出");
    writeStopSentinel(dataRoot, "all");
    const alive = await waitForPidsExit([supervisorPid]);
    for (const pid of alive) {
        if (!canKillProcess(pid, supervisor.cmdline, { role: "supervisor" })) {
            continue;
        }
        logger.warn({ pid }, "supervisor 限时内未退出，树杀兜底");
        killProcessTree(pid, {
            onError: (message) => logger.warn({ pid, message }, "supervisor 树杀失败"),
        });
    }
}

/** 账号树杀涉及的全部 pid（boot pid + selfHostPid）。 */
function runtimePids(runtime: AccountRuntime): number[] {
    return [runtime.pid, ...(runtime.selfHostPid !== undefined ? [runtime.selfHostPid] : [])];
}

/** 全量 stop 兜底：残留账号进程逐个树杀（all 哨兵转发失败场合）。 */
async function stopStragglerAccounts(runtimes: AccountRuntime[]): Promise<void> {
    const stragglers = await waitForPidsExit(runtimes.flatMap(runtimePids));
    for (const runtime of runtimes) {
        if (runtimePids(runtime).some((pid) => stragglers.includes(pid))) {
            killAccountTree(runtime);
        }
    }
}

export async function cmdStop(dataRoot: string, opts: OpsOptions): Promise<void> {
    assertOpsQq(opts);
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
    await stopSupervisor(dataRoot);
    await stopStragglerAccounts(runtimes);
    removeStopSentinel(dataRoot);
}

/** restart：stop 同目标 + detached 拉起（停止失败/入口缺失时不得继续拉起）。 */
export async function cmdRestart(dataRoot: string, opts: OpsOptions): Promise<void> {
    assertOpsQq(opts);
    await cmdStop(dataRoot, opts);
    // cmdStop 失败（目标无运行时状态等）只置 exitCode，不抛错——不拦住会发生
    // 「stop 失败但仍拉起」的假重启。
    if (process.exitCode !== undefined && process.exitCode !== 0) {
        logger.error(
            { qq: opts.qq ?? "(supervisor 全量)" },
            "停止失败（目标未运行等），跳过重新拉起",
        );
        return;
    }
    const entry = process.argv[1];
    if (entry === undefined || entry === "") {
        logger.error("无法确定 cli 入口（process.argv[1] 为空），拒绝拉起空 node 进程");
        process.exitCode = 1;
        return;
    }
    // 等待进程树退出（实例锁：同账号数据目录单实例，立即拉起会抢锁失败）
    await new Promise((resolve) => setTimeout(resolve, 1500));
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
