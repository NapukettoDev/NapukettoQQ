/**
 * 优雅关停（2026-10-25 生命周期契约）：停止哨兵 + 关停钩子 + 信号接入。
 *
 * 背景：Windows 下 SIGTERM 无法投递给无控制台进程（嵌入式宿主 pipe 场景），
 * 既有 `napuketto stop` / 宿主只能 taskkill /T /F 树杀——被杀进程退出码 1，
 * 与真实崩溃无法区分。本模块提供两层机制，三层常驻进程
 * （supervisor / cli boot / self-host）共用：
 *
 * 1. 停止哨兵（规范化通道，宿主零 win32 依赖）：向 `<数据根>/napuketto.stop`
 *    写文件即请求该数据根下的进程树优雅退出。文件内容为目标账号
 *    （空 / "all" = 全部；"<uin>" = 单账号——`napuketto stop -q` 用）。
 *    守卫：mtime 晚于进程启动才触发（陈旧哨兵不触发，守护重启不误杀），
 *    每进程至多触发一次。轮询 500ms（fs.watch 跨平台创建事件不可靠）。
 * 2. 信号（终端场景）：SIGINT/SIGTERM/SIGBREAK（Windows CTRL_BREAK_EVENT
 *    可达）→ requestShutdown，走同一关停编排。
 *
 * 退出码契约：0 = 请求式正常退出；非 0 = 引导失败/运行时致命。taskkill /F
 * 兜底仍产出 code 1，宿主应优先用哨兵通道。
 */
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

/** 哨兵文件名（置于数据根）。 */
export const STOP_SENTINEL_FILENAME = "napuketto.stop";
/** 哨兵轮询间隔（毫秒）。 */
const SENTINEL_POLL_MS = 500;

/** 哨兵文件路径。 */
export function stopSentinelPath(dataRoot: string): string {
    return join(dataRoot, STOP_SENTINEL_FILENAME);
}

/**
 * 写停止哨兵（请求优雅关停）。target = "all"/空 = 全部账号；"<uin>" = 单账号。
 * 任何内容（含空）都视为请求；mtime 由写入时刻决定。
 */
export function writeStopSentinel(dataRoot: string, target: "all" | string): void {
    writeFileSync(stopSentinelPath(dataRoot), target === "all" ? "all\n" : `${target}\n`, "utf8");
}

/** 删除停止哨兵（napuketto stop 等待结束后清理，防陈旧文件累积）。 */
export function removeStopSentinel(dataRoot: string): void {
    const path = stopSentinelPath(dataRoot);
    if (existsSync(path)) {
        try {
            rmSync(path);
        } catch {
            // 删除失败不阻塞（mtime 守卫使陈旧哨兵天然失效）
        }
    }
}

/** 哨兵内容是否命中本观察者（all/空 = 全部；否则精确匹配账号）。 */
function sentinelMatches(content: string, account: string | undefined): boolean {
    const trimmed = content.trim();
    if (trimmed === "" || trimmed === "all") {
        return true;
    }
    return account !== undefined && trimmed === account;
}

/** 哨兵观察选项。 */
export interface StopSentinelWatchOptions {
    /** 数据根（哨兵所在目录）。 */
    dataRoot: string;
    /** 本进程对应账号（uin 或 "default"；undefined = 仅响应 all/空）。 */
    account?: string;
    /** 触发回调（每进程至多一次）。 */
    onTrigger: () => void;
    /** 轮询间隔（测试注入用）。 */
    pollMs?: number;
}

/**
 * 观察停止哨兵：存在、mtime 晚于进程启动且内容命中 → onTrigger（一次性）。
 * 返回取消函数。mtime 守卫：进程启动前遗留的哨兵不触发（守护重启安全）。
 */
export function watchStopSentinel(opts: StopSentinelWatchOptions): () => void {
    const path = stopSentinelPath(opts.dataRoot);
    const processStartMs = performance.timeOrigin;
    let triggered = false;
    const timer = setInterval(() => {
        if (triggered) {
            return;
        }
        let mtimeMs = 0;
        let content = "";
        try {
            if (!existsSync(path)) {
                return;
            }
            mtimeMs = statSync(path).mtimeMs;
            content = readFileSync(path, "utf8");
        } catch {
            // 读写竞态（正在被写/删）：下一轮再看
            return;
        }
        if (mtimeMs <= processStartMs) {
            return;
        }
        if (sentinelMatches(content, opts.account)) {
            triggered = true;
            opts.onTrigger();
        }
    }, opts.pollMs ?? SENTINEL_POLL_MS);
    // 不阻塞进程自然退出
    timer.unref?.();
    return () => {
        triggered = true;
        clearInterval(timer);
    };
}

/** 关停钩子（自建宿主引导链注册：协议适配器停止 / 桥退订等）。 */
type ShutdownHook = () => void | Promise<void>;

const shutdownHooks: ShutdownHook[] = [];
let shutdownStarted = false;

/** 注册关停钩子（按注册逆序执行）。 */
export function registerShutdownHook(hook: ShutdownHook): void {
    if (!shutdownStarted) {
        shutdownHooks.push(hook);
    }
}

/**
 * 执行关停编排：逆序跑全部钩子（单钩子异常不阻断后续）后 exit 0。
 * 幂等（重复调用只跑一次）。退出码 0 = 请求式正常退出（生命周期契约）。
 */
export async function requestShutdown(reason: string): Promise<void> {
    if (shutdownStarted) {
        return;
    }
    shutdownStarted = true;
    process.stdout.write(`[self-host] 优雅关停：${reason}\n`);
    while (shutdownHooks.length > 0) {
        const hook = shutdownHooks.pop();
        if (hook === undefined) {
            break;
        }
        try {
            await hook();
        } catch (err) {
            const message = (err as { message?: unknown } | null)?.message ?? String(err);
            process.stdout.write(`[self-host] 关停钩子异常（继续）: ${message}\n`);
        }
    }
    process.exit(0);
}

/**
 * 信号接入（SIGINT/SIGTERM/SIGBREAK → requestShutdown）。
 * Windows CTRL_BREAK_EVENT 以 SIGBREAK 到达（宿主 CREATE_NEW_PROCESS_GROUP +
 * GenerateConsoleCtrlEvent 可优雅停整树）；终端 Ctrl+C 以 SIGINT 到达。
 */
export function installSignalShutdown(): void {
    const handler = (signal: string): void => {
        void requestShutdown(`信号 ${signal}`);
    };
    process.on("SIGINT", () => handler("SIGINT"));
    process.on("SIGTERM", () => handler("SIGTERM"));
    process.on("SIGBREAK", () => handler("SIGBREAK"));
}
