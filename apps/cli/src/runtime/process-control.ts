import { type ChildProcess, spawn } from "node:child_process";
import process from "node:process";
import { errorMessage, getErrorCode } from "@napuketto/kernel";
import { isValidPid } from "@napuketto/loader";

/** POSIX 强杀升级宽限（毫秒）：SIGTERM 后仍未退出则补 SIGKILL。 */
const FORCE_KILL_GRACE_MS = 1500;

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
        return getErrorCode(err) === "EPERM";
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
    const targets = [...new Set([pid, ...(options.extraPids ?? [])])].filter((target) =>
        isValidPid(target),
    );
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
            if (getErrorCode(err) !== "ESRCH") {
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
