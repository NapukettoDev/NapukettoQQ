/**
 * pid-cmdline.ts：跨进程命令行查询，根治 Windows PID 复用误判——持有者已死但 pid 被复用给无关进程时，process.kill(pid, 0) 仍探活成功。
 * 因此探活通过后还要比对锁内 cmdline 与该 pid 的真实命令行：Windows 走 Get-CimInstance Win32_Process（wmic 已在 Win11 移除）、
 * Linux 走 /proc/<pid>/cmdline（\0 分隔），darwin 等退回纯 pid 探测；查询失败时保守保留持有者，避免平台查询故障时启动双实例。
 * 比对前经 normalizeCmdline 规范化（锁内摘要来自 execArgv/argv join，与系统原始命令行存在引号/大小写/分隔符差异）。
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

/** 当前平台是否支持跨进程 cmdline 查询（不支持则判活退回纯 pid 探测）。 */
export const CMDLINE_PROBE_SUPPORTED = process.platform === "win32" || process.platform === "linux";

/**
 * PID 上限（跨平台保守值）：Windows PID 是 32 位无符号，但 `process.kill` / POSIX
 * signal API 只接受 32 位有符号正整数；Linux 默认 pid_max 远小于此值。
 */
export const MAX_PID = 0x7fffffff;

/**
 * PID 类型与范围校验（唯一口径）：安全整数、`1..MAX_PID`。
 *
 * 拒绝 0 / 负数 / 小数 / NaN / Infinity / 超范围值。调用方在把外部状态文件、
 * IPC 参数或环境值当作 PID 使用前必须先过此守卫；合法 PID 的 signal 0 存活探测
 * 不受影响。
 */
export function isValidPid(value: unknown): value is number {
    return (
        typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_PID
    );
}

/**
 * 查询指定 pid 的当前命令行。
 *
 * @returns 命令行原文；pid 非法 / 进程不存在 / 命令行不可得（权限、系统进程 null）/
 *          查询机制失败（超时、PowerShell 缺失）均返回 null
 */
export function readCmdlineForPid(pid: number): string | null {
    // 先校验再拼命令 / 路径：非法值不得进入 PowerShell 字符串或 /proc/<pid>。
    if (!isValidPid(pid)) {
        return null;
    }
    if (process.platform === "win32") {
        return readWindowsCmdline(pid);
    }
    if (process.platform === "linux") {
        return readLinuxCmdline(pid);
    }
    return null;
}

/** Windows：PowerShell Get-CimInstance 查询（进程不存在时输出空 → null）。 */
function readWindowsCmdline(pid: number): string | null {
    try {
        const out = execFileSync(
            "powershell.exe",
            [
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                // UTF-8 输出避免中文路径被 OEM 代码页转码
                `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;` +
                    `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`,
            ],
            { encoding: "utf-8", timeout: 10_000, windowsHide: true },
        );
        const cmdline = out.trim();
        return cmdline === "" ? null : cmdline;
    } catch {
        return null;
    }
}

/** Linux：/proc/<pid>/cmdline（\0 分隔转空格；进程不存在抛错 → null）。 */
function readLinuxCmdline(pid: number): string | null {
    try {
        const raw = readFileSync(`/proc/${pid}/cmdline`, "utf-8");
        const cmdline = raw.replaceAll("\0", " ").trim();
        return cmdline === "" ? null : cmdline;
    } catch {
        return null;
    }
}

/**
 * 命令行规范化（比对用）：统一大小写 / 去引号 / 路径分隔符归一 / 折叠空白。
 * Windows 路径大小写不敏感，lowercase 安全。
 */
export function normalizeCmdline(cmdline: string): string {
    return cmdline
        .toLowerCase()
        .replaceAll('"', "")
        .replaceAll("\\", "/")
        .replace(/\s+/g, " ")
        .trim();
}
