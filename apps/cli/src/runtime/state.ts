/**
 * 账号运行时状态文件 + 进程控制原语（跨进程通信走 PID 状态文件而非 IPC 通道：现有 stdio JSON 行协议仅
 * koishi 插件用，supervisor 子进程不在此模式，独立 socket/pipe 复杂度高）。supervisor/boot 写
 * `<数据根>/<uin>/runtime.json` 与 `supervisor.json`；status/stop/restart 读文件 + liveness + 树杀。
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import process from "node:process";
import { configError, errorMessage, hasStringProp, isRecord } from "@napuketto/kernel";
import {
    CMDLINE_PROBE_SUPPORTED,
    isValidPid,
    normalizeCmdline,
    readCmdlineForPid,
} from "@napuketto/loader";

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
    /** 启动命令行参数指纹（脚本 + 参数，树杀前 PID 复用校验；旧状态文件可能缺省）。 */
    cmdline?: string;
    /** self-host 子进程命令行参数指纹（树杀前 PID 复用校验；可能缺省）。 */
    selfHostCmdline?: string;
}

/** supervisor 运行时状态（supervisor.json）。 */
export interface SupervisorRuntime {
    pid: number;
    startedAt: string;
    /** 编排的账号列表。 */
    accounts: string[];
    /** 启动命令行参数指纹（脚本 + 参数，stop 前 PID 复用校验；旧状态文件可能缺省）。 */
    cmdline?: string;
}

/**
 * supervisor 注入给受管子进程的托管标记 env。
 *
 * 托管模式下 supervisor 与 boot 共享同一份 runtime.json：supervisor 拥有
 * `kind`/`restartCount`/启动时间与 boot pid，受管 boot 只补充 `selfHost*`。
 * boot 读到该标记即走合并写入（`patchAccountRuntime`），不再整文件覆盖。
 */
export const SUPERVISOR_CHILD_ENV = "NAPUKETTO_SUPERVISOR_CHILD";

/** POSIX 强杀升级宽限（毫秒）：SIGTERM 后仍未退出则补 SIGKILL。 */
const FORCE_KILL_GRACE_MS = 1500;

/** runtime.json 文件名。 */
const RUNTIME_FILE = "runtime.json";
/** supervisor.json 文件名。 */
const SUPERVISOR_FILE = "supervisor.json";

/**
 * 账号数据目录（数据根路径边界防御）：uin 必须是单一路径段，解析后必须落在
 * dataRoot 内。CLI `-q` 入口已按 QQ 号格式校验，这里兜底任何直接调用方
 * （`-q ../../x` / 绝对路径等不得逃出数据根）。非法值抛 ConfigError（exit 78）。
 */
export function accountDir(dataRoot: string, uin: string): string {
    if (uin === "" || uin === "." || uin === ".." || isAbsolute(uin)) {
        throw configError(`非法账号标识 "${uin}"：必须是单个路径段（不允许绝对路径）`);
    }
    if (uin.includes("/") || uin.includes("\\")) {
        throw configError(`非法账号标识 "${uin}"：不允许包含路径分隔符`);
    }
    const root = resolve(dataRoot);
    const resolved = resolve(root, uin);
    if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
        throw configError(`账号数据目录越界: ${resolved} 不在数据根 ${root} 内`);
    }
    // 校验用绝对路径，返回保持既有语义（相对 dataRoot 仍返回相对路径，避免调用方行为漂移）
    return join(dataRoot, uin);
}

/** 账号状态文件路径（经 accountDir 边界校验）。 */
export function runtimeStatePath(dataRoot: string, uin: string): string {
    return join(accountDir(dataRoot, uin), RUNTIME_FILE);
}

/** supervisor 状态文件路径。 */
export function supervisorStatePath(dataRoot: string): string {
    return join(dataRoot, SUPERVISOR_FILE);
}

/** 删除文件（不存在/删除失败不阻塞）。 */
function removeIfExists(path: string): void {
    try {
        rmSync(path, { force: true });
    } catch {
        // 清理失败不掩盖原始写入/替换错误
    }
}

/**
 * 原子写 JSON：同目录唯一临时文件 → rename 覆盖目标。
 *
 * 直接 `writeFileSync` 在并发读取（status/stop 与其他进程）时可能读到截断 JSON；
 * rename 在同一文件系统内是原子的。Windows 下 libuv 的 rename 走
 * `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`，目标已存在时直接替换，因此**不能**
 * 先删目标再 rename（会留下「文件短暂不存在」的空窗）。临时文件名带 pid + UUID，
 * 避免 supervisor / boot 并发写同一目录时互相踩临时文件；写入或替换失败时清理
 * 临时文件后原样抛出。
 */
function writeJsonAtomic(path: string, value: unknown): void {
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true });
    const tmpPath = join(dir, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
    try {
        writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
        renameSync(tmpPath, path);
    } catch (err) {
        removeIfExists(tmpPath);
        throw err;
    }
}

/** 写账号运行时状态（原子覆盖）。 */
export function writeAccountRuntime(dataRoot: string, state: AccountRuntime): void {
    writeJsonAtomic(runtimeStatePath(dataRoot, state.uin), state);
}

/** runtime.json 合并补丁（仅覆盖显式提供的字段）。 */
export interface AccountRuntimePatch {
    pid?: number;
    selfHostPid?: number;
    selfHostCmdline?: string;
    cmdline?: string;
    startedAt?: string;
    kind?: AccountRuntime["kind"];
    status?: AccountRuntime["status"];
    exitCode?: number | null;
    restartCount?: number;
}

/** 过滤 undefined 的补丁字段（exactOptionalPropertyTypes：不显式写 undefined）。 */
function definedPatch(patch: AccountRuntimePatch): Partial<AccountRuntime> {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
    return Object.fromEntries(entries) as Partial<AccountRuntime>;
}

/**
 * 合并写入账号运行时状态（托管模式专用：supervisor 与受管 boot 共享 runtime.json）。
 *
 * 以磁盘现有合法状态为底应用 patch；现有文件缺失/损坏时用 fallback 完整状态兜底。
 * `status` 切回 running 时丢弃上一次的 exitCode（新生命周期），避免 status 显示
 * 「运行中 + 旧退出码」。
 */
export function patchAccountRuntime(
    dataRoot: string,
    uin: string,
    patch: AccountRuntimePatch,
    fallback: AccountRuntime,
): void {
    const base = readAccountRuntime(dataRoot, uin) ?? fallback;
    const next: AccountRuntime = { ...base, ...definedPatch(patch), uin };
    if (next.status === "running") {
        delete next.exitCode;
    } else {
        const exitCode = patch.exitCode === undefined ? base.exitCode : patch.exitCode;
        if (exitCode !== undefined) {
            next.exitCode = exitCode;
        }
    }
    writeJsonAtomic(runtimeStatePath(dataRoot, uin), next);
}

/** 账号运行形态判定。 */
function isAccountRuntimeKind(val: unknown): val is AccountRuntime["kind"] {
    return val === "supervisor-child" || val === "single-boot";
}

/** 账号运行状态判定。 */
function isAccountRuntimeStatus(val: unknown): val is AccountRuntime["status"] {
    return val === "running" || val === "exited";
}

/** 可选字符串字段判定（缺省合法）。 */
function isOptionalString(val: unknown): boolean {
    return val === undefined || typeof val === "string";
}

/** runtime.json 形状守卫（损坏 / 旧格式 / 手工改错的文件一律判非法）。 */
function isAccountRuntime(val: unknown): val is AccountRuntime {
    return (
        isRecord(val) &&
        hasStringProp(val, "uin") &&
        isValidPid(val["pid"]) &&
        hasStringProp(val, "startedAt") &&
        isAccountRuntimeKind(val["kind"]) &&
        isAccountRuntimeStatus(val["status"]) &&
        (val["selfHostPid"] === undefined || isValidPid(val["selfHostPid"])) &&
        isOptionalString(val["cmdline"]) &&
        isOptionalString(val["selfHostCmdline"])
    );
}

/** supervisor.json 形状守卫。 */
function isSupervisorRuntime(val: unknown): val is SupervisorRuntime {
    return (
        isRecord(val) &&
        isValidPid(val["pid"]) &&
        hasStringProp(val, "startedAt") &&
        Array.isArray(val["accounts"]) &&
        val["accounts"].every((item): item is string => typeof item === "string") &&
        isOptionalString(val["cmdline"])
    );
}

/** 读账号运行时状态（缺失/损坏返回 null）。 */
export function readAccountRuntime(dataRoot: string, uin: string): AccountRuntime | null {
    const raw = readJson(runtimeStatePath(dataRoot, uin));
    return isAccountRuntime(raw) ? raw : null;
}

/** 写 supervisor 运行时状态（数据根缺省时自动创建——首次在新目录 start 不再 ENOENT）。 */
export function writeSupervisorRuntime(dataRoot: string, state: SupervisorRuntime): void {
    writeJsonAtomic(supervisorStatePath(dataRoot), state);
}

/** 读 supervisor 运行时状态（缺失返回 null）。 */
export function readSupervisorRuntime(dataRoot: string): SupervisorRuntime | null {
    const raw = readJson(supervisorStatePath(dataRoot));
    return isSupervisorRuntime(raw) ? raw : null;
}

/** 读 JSON 文件（缺失/解析失败返回 null）。 */
function readJson(path: string): unknown {
    try {
        return JSON.parse(readFileSync(path, "utf8"));
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
    if (!isValidPid(pid)) {
        return false;
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        // EPERM：进程存在但无权限（非 Error 形态按「不存在」处理）
        return isRecord(err) && err["code"] === "EPERM";
    }
}

export interface KillProcessTreeOptions {
    /** 附加目标（如 runtime.json 的 selfHostPid）：与主目标一并处理，覆盖孙进程。 */
    extraPids?: number[];
    /** POSIX SIGTERM → SIGKILL 升级宽限（毫秒；<=0 立即升级）。 */
    graceMs?: number;
    /** 诊断回调（taskkill 启动失败 / 非 ESRCH 信号错误；已退出属正常不回调）。 */
    onError?: (message: string) => void;
}

/** 目标进程不存在（ESRCH）：正常路径，不回调 onError。 */
function isNoSuchProcess(err: unknown): boolean {
    return isRecord(err) && err["code"] === "ESRCH";
}

/** 去重并过滤非法 pid（类型/范围统一走 loader isValidPid）。 */
function uniquePids(pids: number[]): number[] {
    return [...new Set(pids)].filter((pid) => isValidPid(pid));
}

/**
 * 树杀（超时兜底强杀）：win32 走 `taskkill /T /F`；POSIX 先 SIGTERM，宽限后对
 * 仍存活目标补 SIGKILL。
 *
 * POSIX 覆盖范围：对每个目标同时尝试进程组（`-pid`，仅当目标恰为组长时生效，
 * 普通进程返回 ESRCH 静默）与单进程，并接受 `extraPids` 传入 selfHostPid——
 * 只发 SIGTERM 且只打 boot pid 会留下忽略信号的卡死进程与 self-host 孤儿。
 * Windows 必须监听 taskkill 的 `error` 事件：spawn 失败（PATH 缺 taskkill 等）
 * 是异步事件，不监听会静默失败。
 */
export function killProcessTree(pid: number, options: KillProcessTreeOptions = {}): void {
    const targets = uniquePids([pid, ...(options.extraPids ?? [])]);
    if (targets.length === 0) {
        return;
    }
    if (process.platform === "win32") {
        for (const target of targets) {
            const killer = spawn("taskkill", ["/PID", String(target), "/T", "/F"], {
                stdio: "ignore",
                windowsHide: true,
            });
            killer.on("error", (err) => {
                options.onError?.(`taskkill 失败（pid ${target}）：${errorMessage(err)}`);
            });
        }
        return;
    }
    const send = (target: number, signal: NodeJS.Signals): void => {
        try {
            process.kill(target, signal);
        } catch (err) {
            if (!isNoSuchProcess(err)) {
                options.onError?.(`发送 ${signal} 失败（pid ${target}）：${errorMessage(err)}`);
            }
        }
    };
    const killTarget = (target: number, signal: NodeJS.Signals): void => {
        // 先试进程组（-pid 只对组长生效；非组长 ESRCH 静默），再试单进程。
        send(-target, signal);
        send(target, signal);
    };
    for (const target of targets) {
        killTarget(target, "SIGTERM");
    }
    const escalate = (): void => {
        for (const target of targets) {
            // 已退出（或 pid 已被回收）不再补刀，缩小 PID 复用误杀窗口。
            if (isPidAlive(target)) {
                killTarget(target, "SIGKILL");
            }
        }
    };
    const graceMs = options.graceMs ?? FORCE_KILL_GRACE_MS;
    if (graceMs <= 0) {
        escalate();
        return;
    }
    const timer = setTimeout(escalate, graceMs);
    timer.unref?.();
}

/** PID 身份校验结果：match = 命令行一致；mismatch = PID 已被复用；unverified = 无摘要/平台不支持。 */
export type ProcessIdentity = "match" | "mismatch" | "unverified";

/**
 * 本进程命令行指纹（`argv[1..]`，不含可执行文件）。
 *
 * 不用 loader `selfCmdline()` 直接比对：它把 execArgv 排在 argv 前、且 argv[0]
 * 常是裸 `node`，与操作系统记录的完整命令行（可执行文件绝对路径 + execArgv +
 * 脚本 + 参数）顺序/前缀不一致，容易误判成「PID 已复用」而让 stop 失效。
 * 指纹只取脚本及其后的参数，校验时按规范化子串匹配。
 */
export function selfArgvFingerprint(): string | undefined {
    const args = process.argv.slice(1);
    return args.length > 0 ? args.join(" ") : undefined;
}

/**
 * 树杀前 PID 身份校验（防 PID 复用误杀，口径同 loader `checkInstanceLock`）：
 * 记录的「脚本 + 参数」指纹必须出现在目标进程当前命令行中（规范化后子串比对，
 * 对可执行文件绝对路径 / execArgv / 引号 / 路径分隔符差异免疫）。查不到（进程
 * 刚退 / 权限不足）→ mismatch；平台不支持探针或旧状态文件无指纹 → unverified
 * （调用方保守沿用旧行为，不因升级而让 stop 失效）。
 */
export function checkProcessIdentity(pid: number, cmdline: string | undefined): ProcessIdentity {
    if (!isValidPid(pid)) {
        return "mismatch";
    }
    if (cmdline === undefined || cmdline === "" || !CMDLINE_PROBE_SUPPORTED) {
        return "unverified";
    }
    const current = readCmdlineForPid(pid);
    if (current === null) {
        return "mismatch";
    }
    return normalizeCmdline(current).includes(normalizeCmdline(cmdline)) ? "match" : "mismatch";
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
    /** self-host 子进程 pid（诊断；可能缺省）。 */
    selfHostPid?: number;
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
        ...(r.selfHostPid !== undefined ? { selfHostPid: r.selfHostPid } : {}),
        alive: r.status === "running" ? aliveFn(r.pid) : false,
        kind: r.kind,
        startedAt: r.startedAt,
        restartCount: r.restartCount ?? 0,
        exitCode: r.exitCode,
    }));
}
