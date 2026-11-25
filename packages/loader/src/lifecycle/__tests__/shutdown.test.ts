/**
 * shutdown.test.ts：优雅关停单测（2026-10-25 优雅关停）。
 *
 * 覆盖同一生产模块（lifecycle/shutdown.ts）的两个面（2026-11-25 P2 合并
 * sentinel.test.ts：停止哨兵与关停钩子本来就同属一个模块的契约）：
 *  1. 关停钩子编排 / 信号接入 / 退出码
 *  2. 停止哨兵：all/空内容触发、单账号精确匹配、陈旧 mtime 不触发、一次性触发、
 *     取消观察、单账号独立文件（并发 stop -q 互不覆盖、清理只动本账号）
 *
 * requestShutdown 触发模块级幂等状态——每个用例 vi.resetModules 重载模块，
 * 保证钩子队列从零开始。信号测试直调新挂的监听器（不 process.emit，避免触发
 * 测试 runner 自身的信号处理）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
    accountStopSentinelPath,
    removeAccountStopSentinel,
    removeStopSentinel,
    stopSentinelPath,
    watchStopSentinel,
    writeAccountStopSentinel,
    writeStopSentinel,
} from "../shutdown.js";

const log = vi.hoisted(() => vi.fn());
vi.mock("../../shared/boot-log.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../shared/boot-log.js")>()),
    log,
}));

type ShutdownModule = typeof import("../shutdown.js");

async function freshShutdown(): Promise<ShutdownModule> {
    vi.resetModules();
    return await import("../shutdown.js");
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe("registerShutdownHook / requestShutdown", () => {
    it("钩子按注册逆序执行后 exit 0，诊断走安全日志", async () => {
        const mod = await freshShutdown();
        const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
        const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
        const order: string[] = [];
        mod.registerShutdownHook(() => {
            order.push("a");
        });
        mod.registerShutdownHook(() => {
            order.push("b");
        });
        await mod.requestShutdown("单测请求");
        expect(order).toEqual(["b", "a"]);
        expect(exitSpy).toHaveBeenCalledWith(0);
        expect(log).toHaveBeenCalledWith(expect.stringContaining("关停：单测请求"));
        expect(writeSpy).not.toHaveBeenCalled();
    });

    it("单个钩子抛异常不阻断后续钩子", async () => {
        const mod = await freshShutdown();
        vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
        const order: string[] = [];
        mod.registerShutdownHook(() => {
            order.push("a");
        });
        mod.registerShutdownHook(() => {
            throw new Error("钩子炸了");
        });
        await mod.requestShutdown("单测请求");
        expect(order).toEqual(["a"]);
        expect(log).toHaveBeenCalledWith(expect.stringContaining("钩子炸了"));
    });

    it("幂等：重复调用只编排一次；关停后注册的钩子不再执行", async () => {
        const mod = await freshShutdown();
        const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
        vi.spyOn(process.stdout, "write").mockImplementation(() => true);
        const hook = vi.fn();
        mod.registerShutdownHook(hook);
        await mod.requestShutdown("第一次");
        mod.registerShutdownHook(hook);
        await mod.requestShutdown("第二次");
        expect(hook).toHaveBeenCalledOnce();
        expect(exitSpy).toHaveBeenCalledOnce();
        expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it("关停始终先停接收，挂起的协议停止超时后仍释放服务并保留首次退出码", async () => {
        vi.useFakeTimers();
        try {
            const mod = await freshShutdown();
            const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
            const steps: string[] = [];
            mod.registerShutdownHook(() => {
                steps.push("service");
            });
            mod.registerShutdownHook(() => {
                steps.push("intake");
            }, "intake");
            mod.registerShutdownHook(() => {
                steps.push("protocol");
                return new Promise(() => undefined);
            }, "protocols");
            const first = mod.requestShutdown("first", 78);
            expect(mod.requestShutdown("second")).toBe(first);
            await vi.advanceTimersByTimeAsync(1500);
            await first;
            expect(steps).toEqual(["intake", "protocol", "service"]);
            expect(exit).toHaveBeenCalledExactlyOnceWith(78);
        } finally {
            vi.useRealTimers();
        }
    });

    it("异步钩子（返回 Promise）被等待", async () => {
        const mod = await freshShutdown();
        const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
        vi.spyOn(process.stdout, "write").mockImplementation(() => true);
        let observed = "";
        mod.registerShutdownHook(async () => {
            observed = "异步完成";
        });
        await mod.requestShutdown("单测请求");
        expect(observed).toBe("异步完成");
        expect(exitSpy).toHaveBeenCalledWith(0);
    });
});

describe("installSignalShutdown", () => {
    it("SIGINT/SIGTERM/SIGBREAK 三信号接入 requestShutdown（exit 0）", async () => {
        const mod = await freshShutdown();
        const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
        vi.spyOn(process.stdout, "write").mockImplementation(() => true);
        const before = {
            SIGINT: process.listeners("SIGINT"),
            SIGTERM: process.listeners("SIGTERM"),
            SIGBREAK: process.listeners("SIGBREAK"),
        };
        mod.installSignalShutdown();
        const added = {
            SIGINT: process.listeners("SIGINT").filter((l) => !before.SIGINT.includes(l))[0],
            SIGTERM: process.listeners("SIGTERM").filter((l) => !before.SIGTERM.includes(l))[0],
            SIGBREAK: process.listeners("SIGBREAK").filter((l) => !before.SIGBREAK.includes(l))[0],
        };
        try {
            expect(added.SIGINT).toBeDefined();
            expect(added.SIGTERM).toBeDefined();
            expect(added.SIGBREAK).toBeDefined();
            (added.SIGINT as () => void)();
            await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0));
        } finally {
            for (const [signal, listener] of Object.entries(added)) {
                if (listener !== undefined) {
                    process.removeListener(signal as NodeJS.Signals, listener);
                }
            }
        }
    });
});

describe("停止哨兵文件（write / remove / path）", () => {
    it("stopSentinelPath：数据根 + 固定文件名", async () => {
        const mod = await freshShutdown();
        expect(mod.stopSentinelPath("/data")).toContain("napuketto.stop");
    });

    it("writeStopSentinel：all → 'all\\n'；单账号 → '<uin>\\n'", async () => {
        const mod = await freshShutdown();
        const dir = mkdtempSync(join(tmpdir(), "napuketto-shutdown-test-"));
        try {
            mod.writeStopSentinel(dir, "all");
            expect(readFileSync(mod.stopSentinelPath(dir), "utf8")).toBe("all\n");
            mod.writeStopSentinel(dir, "10001");
            expect(readFileSync(mod.stopSentinelPath(dir), "utf8")).toBe("10001\n");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("removeStopSentinel：存在删除；不存在幂等", async () => {
        const mod = await freshShutdown();
        const dir = mkdtempSync(join(tmpdir(), "napuketto-shutdown-test-"));
        try {
            mod.writeStopSentinel(dir, "all");
            expect(existsSync(mod.stopSentinelPath(dir))).toBe(true);
            mod.removeStopSentinel(dir);
            expect(existsSync(mod.stopSentinelPath(dir))).toBe(false);
            // 幂等：再删不抛
            expect(() => mod.removeStopSentinel(dir)).not.toThrow();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

// ── 停止哨兵（原 sentinel.test.ts，2026-11-25 P2 并入同一生产模块的单测）──

let tmpRoot = "";
afterAll(() => {
    if (tmpRoot !== "") {
        rmSync(tmpRoot, { recursive: true, force: true });
    }
});

function freshDir(): string {
    tmpRoot = mkdtempSync(join(tmpdir(), "napuketto-sentinel-test-"));
    return tmpRoot;
}

/** 等待哨兵轮询若干轮。 */
async function settle(ms = 60): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("writeStopSentinel / watchStopSentinel", () => {
    it("all 内容触发；触发一次后不再触发", async () => {
        const dir = freshDir();
        const onTrigger = vi.fn();
        watchStopSentinel({ dataRoot: dir, account: "10000", onTrigger, pollMs: 10 });
        writeStopSentinel(dir, "all");
        await settle();
        expect(onTrigger).toHaveBeenCalledTimes(1);
        // 二次写入不重复触发（一次性守卫）
        writeStopSentinel(dir, "all");
        await settle();
        expect(onTrigger).toHaveBeenCalledTimes(1);
    });

    it("空内容 = all（宿主 touch 文件即可）", async () => {
        const dir = freshDir();
        const onTrigger = vi.fn();
        watchStopSentinel({ dataRoot: dir, account: "10000", onTrigger, pollMs: 10 });
        writeFileSync(stopSentinelPath(dir), "", "utf8");
        await settle();
        expect(onTrigger).toHaveBeenCalledTimes(1);
    });

    it("单账号内容精确匹配；他人账号不触发", async () => {
        const dir = freshDir();
        const mine = vi.fn();
        const other = vi.fn();
        watchStopSentinel({ dataRoot: dir, account: "10000", onTrigger: mine, pollMs: 10 });
        watchStopSentinel({ dataRoot: dir, account: "20000", onTrigger: other, pollMs: 10 });
        writeStopSentinel(dir, "10000");
        await settle();
        expect(mine).toHaveBeenCalledTimes(1);
        expect(other).not.toHaveBeenCalled();
    });

    it("无 account 的观察者只响应 all/空", async () => {
        const dir = freshDir();
        const onTrigger = vi.fn();
        watchStopSentinel({ dataRoot: dir, onTrigger, pollMs: 10 });
        writeStopSentinel(dir, "10000");
        await settle();
        expect(onTrigger).not.toHaveBeenCalled();
        writeStopSentinel(dir, "all");
        await settle();
        expect(onTrigger).toHaveBeenCalledTimes(1);
    });

    it("陈旧哨兵（mtime 早于进程启动）不触发——守护重启安全", async () => {
        const dir = freshDir();
        const path = stopSentinelPath(dir);
        writeFileSync(path, "all\n", "utf8");
        // 回拨 mtime 到进程启动前（performance.timeOrigin 之前）
        utimesSync(path, new Date(0), new Date(0));
        const onTrigger = vi.fn();
        watchStopSentinel({ dataRoot: dir, account: "10000", onTrigger, pollMs: 10 });
        await settle(120);
        expect(onTrigger).not.toHaveBeenCalled();
    });

    it("取消观察后不再触发", async () => {
        const dir = freshDir();
        const onTrigger = vi.fn();
        const cancel = watchStopSentinel({
            dataRoot: dir,
            account: "10000",
            onTrigger,
            pollMs: 10,
        });
        cancel();
        writeStopSentinel(dir, "all");
        await settle();
        expect(onTrigger).not.toHaveBeenCalled();
    });
});

describe("单账号独立哨兵（并发 stop -q 安全）", () => {
    it("并发写两个账号：互不覆盖，各自观察者只触发一次", async () => {
        const dir = freshDir();
        const mine = vi.fn();
        const other = vi.fn();
        watchStopSentinel({ dataRoot: dir, account: "10000", onTrigger: mine, pollMs: 10 });
        watchStopSentinel({ dataRoot: dir, account: "20000", onTrigger: other, pollMs: 10 });
        writeAccountStopSentinel(dir, "10000");
        writeAccountStopSentinel(dir, "20000");
        await settle();
        expect(mine).toHaveBeenCalledTimes(1);
        expect(other).toHaveBeenCalledTimes(1);
        // 两个文件同时存在——后写者没有覆盖前写者
        expect(existsSync(accountStopSentinelPath(dir, "10000"))).toBe(true);
        expect(existsSync(accountStopSentinelPath(dir, "20000"))).toBe(true);
    });

    it("清理只删本账号文件：不提前移除并发请求，也不误删全局哨兵", async () => {
        const dir = freshDir();
        writeAccountStopSentinel(dir, "10000");
        writeAccountStopSentinel(dir, "20000");
        writeStopSentinel(dir, "all");
        removeAccountStopSentinel(dir, "10000");
        expect(existsSync(accountStopSentinelPath(dir, "10000"))).toBe(false);
        expect(existsSync(accountStopSentinelPath(dir, "20000"))).toBe(true);
        expect(existsSync(stopSentinelPath(dir))).toBe(true);
        removeStopSentinel(dir);
        // 全局清理不应连带删除其他账号的独立哨兵
        expect(existsSync(accountStopSentinelPath(dir, "20000"))).toBe(true);
    });

    it("陈旧单账号哨兵（mtime 早于进程启动）不触发", async () => {
        const dir = freshDir();
        writeAccountStopSentinel(dir, "10000");
        const path = accountStopSentinelPath(dir, "10000");
        utimesSync(path, new Date(0), new Date(0));
        const onTrigger = vi.fn();
        watchStopSentinel({ dataRoot: dir, account: "10000", onTrigger, pollMs: 10 });
        await settle(120);
        expect(onTrigger).not.toHaveBeenCalled();
    });

    it("单账号哨兵不影响无 account 观察者（supervisor 只认全局 all）", async () => {
        const dir = freshDir();
        const onTrigger = vi.fn();
        watchStopSentinel({ dataRoot: dir, onTrigger, pollMs: 10 });
        writeAccountStopSentinel(dir, "10000");
        await settle();
        expect(onTrigger).not.toHaveBeenCalled();
    });
});
