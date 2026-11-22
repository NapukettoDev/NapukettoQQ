/**
 * pid-cmdline.ts：跨进程命令行查询（instance-lock pid 复用根治，2026-09-10）。
 *
 * 背景（2026-09-08 实测事故）：锁内 pid 的持有者已死、pid 被 Windows 复用给
 * 无关进程时，process.kill(pid, 0) 探活成功 → 误判存活 → 新实例永久拒绝启动
 * （只能手动删锁恢复）。根治：探活通过后再查该 pid 当前的真实命令行，与锁内
 * cmdline 比对只在能查询到实际命令行时使用。不一致表明 PID 已被其他进程
 * 使用；查询失败时保守保留正常探活的持有者，避免在平台查询故障时启动双实例。
 *
 * 平台实现：Windows 走 PowerShell Get-CimInstance Win32_Process 跨进程查询
 * （仅在启动判活时调用一次，冷启动 ~0.5-2s 可接受；wmic 在新 Win11 已移除，
 * 不可用）。Linux 走 /proc/<pid>/cmdline（\0 分隔）。其余平台（darwin 等）
 * 不支持——判活退回纯 pid 探测（旧行为）。
 *
 * 比对不要求逐字符相等：锁内摘要来自 process.execArgv/argv join，查询侧
 * 拿到的是操作系统记录的原始命令行，两者存在引号 / 大小写 / 路径分隔符差异
 * ——统一经 normalizeCmdline 规范化后比对。残余差异源（8.3 短路径、相对
 * 启动路径）极罕见，误判后果同上（可恢复），接受。
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

/** 当前平台是否支持跨进程 cmdline 查询（不支持则判活退回纯 pid 探测）。 */
export const CMDLINE_PROBE_SUPPORTED = process.platform === "win32" || process.platform === "linux";

/**
 * 查询指定 pid 的当前命令行。
 *
 * @returns 命令行原文；进程不存在 / 命令行不可得（权限、系统进程 null）/
 *          查询机制失败（超时、PowerShell 缺失）均返回 null
 */
export function readCmdlineForPid(pid: number): string | null {
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
