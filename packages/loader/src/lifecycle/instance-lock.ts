import { randomUUID } from "node:crypto";
import {
    mkdirSync,
    readdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmdirSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { log } from "../shared/boot-log.js";
import { isRecord, parseJsonWithGuard } from "../shared/type-guards.js";
import {
    CMDLINE_PROBE_SUPPORTED,
    isValidPid,
    normalizeCmdline,
    readCmdlineForPid,
} from "./pid-cmdline.js";

export const INSTANCE_LOCK_FILE = "instance.lock";

/** 保留旧格式字段，owner 仅由实际取得锁的进程持有。 */
export interface InstanceLockInfo {
    pid: number;
    startedAt: number;
    cmdline?: string;
    owner?: string;
}

export interface InstanceLockCheck {
    occupied: boolean;
    pid: number | null;
    lockPath: string;
}

const OWNER_PATTERN = /^[0-9a-f-]{36}$/;
const owners = new Map<string, string>();

function isInstanceLockInfo(value: unknown): value is InstanceLockInfo {
    return (
        isRecord(value) &&
        isValidPid(value["pid"]) &&
        typeof value["startedAt"] === "number" &&
        Number.isFinite(value["startedAt"]) &&
        (value["cmdline"] === undefined || typeof value["cmdline"] === "string") &&
        (value["owner"] === undefined || typeof value["owner"] === "string")
    );
}

function isMissing(error: unknown): boolean {
    return isRecord(error) && error["code"] === "ENOENT";
}

function readLock(path: string): InstanceLockInfo | null {
    try {
        return parseJsonWithGuard(readFileSync(path, "utf-8"), isInstanceLockInfo);
    } catch (err) {
        if (isMissing(err)) {
            return null;
        }
        throw err;
    }
}

function isHolderAlive(info: InstanceLockInfo): boolean {
    try {
        process.kill(info.pid, 0);
    } catch (err) {
        // EPERM 表示进程仍可能存在，只有 ESRCH 能确认它已退出。
        return !isRecord(err) || err["code"] !== "ESRCH";
    }
    if (!CMDLINE_PROBE_SUPPORTED || !info.cmdline) {
        return true;
    }
    const current = readCmdlineForPid(info.pid);
    return current === null || normalizeCmdline(current) === normalizeCmdline(info.cmdline);
}

/** 只读预检；取得锁必须在写入互斥内再次校验。 */
export function checkInstanceLock(dataDir: string): InstanceLockCheck {
    const lockPath = join(dataDir, INSTANCE_LOCK_FILE);
    try {
        const info = readLock(lockPath);
        const occupied = info !== null && isHolderAlive(info);
        return { occupied, pid: occupied ? info.pid : null, lockPath };
    } catch {
        return { occupied: true, pid: null, lockPath };
    }
}

function unlinkIfPresent(path: string): void {
    try {
        unlinkSync(path);
    } catch (err) {
        if (!isMissing(err)) {
            throw err;
        }
    }
}

function removeEmptyDirectory(path: string): void {
    try {
        rmdirSync(path);
    } catch (err) {
        // 其他进程可能已发布新目录；它的唯一标记使 rmdir 不能移除它。
        if (!isMissing(err) && (!isRecord(err) || err["code"] !== "ENOTEMPTY")) {
            throw err;
        }
    }
}

function reclaimMutationDirectory(path: string): boolean {
    let entries: string[];
    try {
        entries = readdirSync(path);
    } catch (err) {
        if (isMissing(err)) {
            return true;
        }
        throw err;
    }
    const marker = entries.find((entry) => OWNER_PATTERN.test(entry));
    if (entries.some((entry) => entry !== marker && entry !== `${marker}.lock`)) {
        return false;
    }
    if (marker !== undefined) {
        const pathToMarker = join(path, marker);
        const holder = readLock(pathToMarker);
        if (holder !== null && isHolderAlive(holder)) {
            return false;
        }
        unlinkIfPresent(join(path, `${marker}.lock`));
        unlinkIfPresent(pathToMarker);
    }
    removeEmptyDirectory(path);
    return true;
}

/**
 * 原子发布装有唯一标记的变更目录。所有更新对同一个目录串行化。
 * 路径换代时，旧持有者只能删除自己那代的标记；非空目录无法被 rmdir/rename 替换。
 */
function mutateLock(
    lockPath: string,
    mutation: (guard: string, token: string) => boolean,
): boolean {
    const guard = `${lockPath}.guard`;
    const token = randomUUID();
    const temporary = `${guard}.${token}`;
    const marker = join(temporary, token);
    mkdirSync(temporary, { mode: 0o700 });
    let acquired = false;
    try {
        // 变更窗口内只有同步文件操作。标记只需确认 PID 死亡，存活则保守等待。
        writeFileSync(marker, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), {
            mode: 0o600,
        });
        for (let attempt = 0; attempt < 4; attempt++) {
            try {
                renameSync(temporary, guard);
                acquired = true;
                break;
            } catch {
                if (!reclaimMutationDirectory(guard)) {
                    return false;
                }
            }
        }
        return acquired && mutation(guard, token);
    } finally {
        const directory = acquired ? guard : temporary;
        unlinkIfPresent(join(directory, token));
        removeEmptyDirectory(directory);
    }
}

/** 获取账号目录锁，成功时记录本进程持有的令牌。 */
export function acquireInstanceLock(dataDir: string, cmdline?: string): boolean {
    try {
        const lockPath = join(realpathSync(dataDir), INSTANCE_LOCK_FILE);
        const current = readLock(lockPath);
        if (current?.owner !== undefined && owners.get(lockPath) === current.owner) {
            return true;
        }
        if (current !== null && isHolderAlive(current)) {
            return false;
        }
        const owner = randomUUID();
        const command = cmdline || readCmdlineForPid(process.pid) || "";
        return mutateLock(lockPath, (guard, token) => {
            const info = readLock(lockPath);
            if (info !== null && isHolderAlive(info)) {
                return info.owner !== undefined && owners.get(lockPath) === info.owner;
            }
            const record: InstanceLockInfo = {
                pid: process.pid,
                startedAt: Date.now(),
                owner,
                ...(command !== "" ? { cmdline: command } : {}),
            };
            const temporary = join(guard, `${token}.lock`);
            try {
                writeFileSync(temporary, JSON.stringify(record), { flag: "wx", mode: 0o600 });
                renameSync(temporary, lockPath);
                owners.set(lockPath, owner);
                return true;
            } finally {
                unlinkIfPresent(temporary);
            }
        });
    } catch (err) {
        log(`[self-host] 实例锁获取失败: ${String(err)}`);
        return false;
    }
}

function releaseOwnedLock(lockPath: string, owner: string): void {
    try {
        mutateLock(lockPath, () => {
            const current = readLock(lockPath);
            if (current?.owner === owner && current.pid === process.pid) {
                unlinkIfPresent(lockPath);
            }
            if (owners.get(lockPath) === owner) {
                owners.delete(lockPath);
            }
            return true;
        });
    } catch (err) {
        log(`[self-host] 实例锁释放失败: ${String(err)}`);
    }
}

function getOwnedLock(dataDir: string): { lockPath: string; owner: string } | undefined {
    try {
        const lockPath = join(realpathSync(dataDir), INSTANCE_LOCK_FILE);
        const owner = owners.get(lockPath);
        return owner === undefined ? undefined : { lockPath, owner };
    } catch (err) {
        if (!isMissing(err)) {
            log(`[self-host] 无法查找实例锁: ${String(err)}`);
        }
        return undefined;
    }
}

export function releaseInstanceLock(dataDir: string): void {
    const lock = getOwnedLock(dataDir);
    if (lock !== undefined) {
        releaseOwnedLock(lock.lockPath, lock.owner);
    }
}

/** 捕获当前令牌，延迟退出回调不能释放本进程后来取得的锁。 */
export function registerLockCleanup(dataDir: string): void {
    const lock = getOwnedLock(dataDir);
    if (lock !== undefined) {
        process.once("exit", () => releaseOwnedLock(lock.lockPath, lock.owner));
    }
}
