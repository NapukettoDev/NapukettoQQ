import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import process from "node:process";
import { configError, hasOptionalStringProp, hasStringProp, isRecord } from "@napuketto/kernel";
import { isValidPid } from "@napuketto/loader";

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
function writeJsonAtomic(path: string, value: AccountRuntime | SupervisorRuntime): void {
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
        hasOptionalStringProp(val, "cmdline") &&
        hasOptionalStringProp(val, "selfHostCmdline")
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
        hasOptionalStringProp(val, "cmdline")
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
