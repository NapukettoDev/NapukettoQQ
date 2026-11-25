/**
 * boot-log.ts：引导进程文件日志（shared 最底层，零内部依赖）。
 * 落点 `NAPUKETTO_CFG_DIR/napuketto-boot.log`（缺失时落系统临时目录），写入失败静默；直读 process.env，不 import host/。
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
        // best-effort：日志落盘失败不影响引导
    }
}

/** boot 日志路径（致命错误提示 / 排障用）。 */
export function bootLogPath(): string {
    return LOG_PATH;
}

/**
 * 致命引导错误输出：写 napuketto-boot.log 并同步到 stderr——只落文件时 Docker/终端只见 code=1 而无原因。
 * 严禁写 stdout：IPC 模式（NAPUKETTO_IPC=1）stdout 专用于 JSON 行协议，写入会撕裂协议行；
 * stderr 是独立通道，cli/boot.ts 的 forwardChildOutput 与 supervisor 都会逐行转发。
 */
export function logFatal(msg: string): void {
    log(msg);
    process.stderr.write(`[napuketto] ${msg}\n[napuketto] 详细日志: ${LOG_PATH}\n`);
}
