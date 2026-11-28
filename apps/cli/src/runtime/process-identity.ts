import process from "node:process";
import {
    CMDLINE_PROBE_SUPPORTED,
    isValidPid,
    normalizeCmdline,
    readCmdlineForPid,
} from "@napuketto/loader";

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
