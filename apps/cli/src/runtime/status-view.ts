import { isPidAlive } from "./process-control.js";
import type { AccountRuntime } from "./state-store.js";

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
