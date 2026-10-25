/**
 * state.ts：账号运行时状态文件 + 进程控制原语（2026-09-08 T8）。
 *
 * 跨进程通信选型（决策记录）：现有 IPC 为 stdio JSON 行协议（NAPUTO_IPC=1，
 * koishi 插件专用），supervisor 子进程不在此模式；引入独立通道（socket/pipe）
 * 复杂度高。采用 **PID 状态文件**：supervisor/单账号 boot 启动时把进程信息写
 * `<数据根>/<uin>/runtime.json`，supervisor 自身写 `<数据根>/supervisor.json`；
 * `napuketto status/stop/restart` 读文件 + liveness 检测 + 树杀（win32
 * taskkill /T /F，杀 boot 进程树连带 self-host 孙进程）+ detached 重启。
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

/** 账号运行时状态（runtime.json）。 */
export interface AccountRuntime {
    /** 账号 QQ 号（= 数据目录名）。 */
    uin: string;
    /** 宿主引导进程 pid（boot 进程；树杀连带 self-host 孙进程）。 */
    pid: number;
    /** self-host 子进程 pid（诊断用，可能缺省）。 */
    selfHostPid?: number;
    /** 启动时间（ISO 字符串）。 */
    startedAt: string;
    /** 运行形态。 */
    kind: "supervisor-child" | "single-boot";
    /** 状态（写入时快照；读取方用 liveness 修正显示）。 */
    status: "running" | "exited";
    /** 退出码（status=exited 时）。 */
    exitCode?: number | null;
    /** supervisor 守护重启次数。 */
    restartCount?: number;
}

/** supervisor 运行时状态（supervisor.json）。 */
export interface SupervisorRuntime {
    pid: number;
    startedAt: string;
    /** 编排的账号列表。 */
    accounts: string[];
}

/** runtime.json 文件名。 */
const RUNTIME_FILE = "runtime.json";
/** supervisor.json 文件名。 */
const SUPERVISOR_FILE = "supervisor.json";

/** 账号状态文件路径。 */
export function runtimeStatePath(dataRoot: string, uin: string): string {
    return join(dataRoot, uin, RUNTIME_FILE);
}

/** supervisor 状态文件路径。 */
export function supervisorStatePath(dataRoot: string): string {
    return join(dataRoot, SUPERVISOR_FILE);
}

/** 写账号运行时状态（原子覆盖）。 */
export function writeAccountRuntime(dataRoot: string, state: AccountRuntime): void {
    const path = runtimeStatePath(dataRoot, state.uin);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/** 读账号运行时状态（缺失/损坏返回 null）。 */
export function readAccountRuntime(dataRoot: string, uin: string): AccountRuntime | null {
    return readJson(runtimeStatePath(dataRoot, uin)) as AccountRuntime | null;
}

/** 写 supervisor 运行时状态。 */
export function writeSupervisorRuntime(dataRoot: string, state: SupervisorRuntime): void {
    writeFileSync(supervisorStatePath(dataRoot), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/** 读 supervisor 运行时状态（缺失返回 null）。 */
export function readSupervisorRuntime(dataRoot: string): SupervisorRuntime | null {
    return readJson(supervisorStatePath(dataRoot)) as SupervisorRuntime | null;
}

/** 读 JSON 文件（缺失/解析失败返回 null）。 */
function readJson(path: string): unknown {
    try {
        return JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch {
        return null;
    }
}

/** 列出数据根下全部账号运行时状态（扫一级目录 runtime.json）。 */
export function listAccountRuntimes(dataRoot: string): AccountRuntime[] {
    let entries: string[] = [];
    try {
        entries = readdirSync(dataRoot, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name);
    } catch {
        return [];
    }
    const out: AccountRuntime[] = [];
    for (const uin of entries) {
        const state = readAccountRuntime(dataRoot, uin);
        if (state !== null) {
            out.push(state);
        }
    }
    return out;
}

/** pid 存活检测（signal 0；EPERM 视为存活——进程存在但无权限）。 */
export function isPidAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) {
        return false;
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === "EPERM";
    }
}

/** 树杀命令构造（win32：taskkill /T /F 连孙进程；posix：kill 信号）。 */
export function killProcessTree(pid: number): void {
    if (process.platform === "win32") {
        spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
        return;
    }
    try {
        process.kill(pid, "SIGTERM");
    } catch {
        // 已退出：无需处理
    }
}

/** detached 拉起 node 进程（restart 用；立即返回不等待）。 */
export function spawnDetached(args: string[], cwd?: string): ChildProcess {
    const child = spawn(process.execPath, args, {
        detached: true,
        stdio: "ignore",
        ...(cwd !== undefined ? { cwd } : {}),
    });
    child.unref();
    return child;
}

/** 状态聚合视图（status 命令输出）。 */
export interface AccountStatusRow {
    uin: string;
    pid: number;
    /** 文件状态 + liveness 修正后的实际状态。 */
    alive: boolean;
    kind: AccountRuntime["kind"];
    startedAt: string;
    restartCount: number;
    exitCode: number | null | undefined;
}

/** 聚合各账号状态（liveness 修正：文件 running 但 pid 已死 → not running）。 */
export function aggregateStatus(
    runtimes: AccountRuntime[],
    aliveFn: (pid: number) => boolean = isPidAlive,
): AccountStatusRow[] {
    return runtimes.map((r) => ({
        uin: r.uin,
        pid: r.pid,
        alive: r.status === "running" ? aliveFn(r.pid) : false,
        kind: r.kind,
        startedAt: r.startedAt,
        restartCount: r.restartCount ?? 0,
        exitCode: r.exitCode,
    }));
}
