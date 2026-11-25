/**
 * boot-log.ts：引导进程文件日志（shared 最底层，零内部依赖）。
 *
 * lifecycle/ 与 qq/ 需要错误留痕，但不得反向依赖 host/ 分组（依赖方向红线），
 * 因此日志能力下沉到 shared/。日志本身的落点与格式保持原样：
 * `NAPUKETTO_CFG_DIR/napuketto-boot.log`（缺失时落系统临时目录），失败静默。
 *
 * 只读 process.env（不做 host/runtime/env.ts 快照）：本模块是 host/ 的下游，不能 import host/。
 */
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

/** boot 日志路径（NAPUKETTO_CFG_DIR 下，与 stub 验证日志同目录）。 */
const LOG_PATH = process.env["NAPUKETTO_CFG_DIR"]
    ? join(process.env["NAPUKETTO_CFG_DIR"], "napuketto-boot.log")
    : join(tmpdir(), "napuketto-boot.log");

/** 追加一行 boot 日志（失败静默，不阻塞引导）。 */
export function log(msg: string): void {
    try {
        appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`);
    } catch {
        // ignore
    }
}

/** boot 日志路径（致命错误提示 / 排障用）。 */
export function bootLogPath(): string {
    return LOG_PATH;
}

/**
 * 致命引导错误输出（issue #144）：写 napuketto-boot.log，并同步到 stderr。
 *
 * 此前致命失败只落 boot 日志，Docker / 终端只看到 code=1 而没有任何原因。
 * 严禁写 stdout：IPC 模式（NAPUKETTO_IPC=1）stdout 专用于 JSON 行协议，写入会撕裂
 * 协议行；stderr 是独立通道，cli/boot.ts 的 forwardChildOutput 与 supervisor
 * 都会逐行转发（非 IPC / IPC 两种宿主都可见）。
 */
export function logFatal(msg: string): void {
    log(msg);
    process.stderr.write(`[napuketto] ${msg}\n[napuketto] 详细日志: ${LOG_PATH}\n`);
}
