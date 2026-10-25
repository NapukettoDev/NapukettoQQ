/**
 * shutdown.test.ts：关停钩子编排 + 信号接入单测（2026-10-25 优雅关停）。
 *
 * requestShutdown 触发模块级幂等状态——每个用例 vi.resetModules 重载模块，
 * 保证钩子队列与 shutdownStarted 从零开始。信号测试直调新挂的监听器
 * （不 process.emit，避免触发测试 runner 自身的信号处理）。
 */
import process from "node:process";
import { afterEach, describe, expect, it, vi } from "vitest";

type ShutdownModule = typeof import("../shutdown.js");

async function freshShutdown(): Promise<ShutdownModule> {
    vi.resetModules();
    return await import("../shutdown.js");
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe("registerShutdownHook / requestShutdown", () => {
    it("钩子按注册逆序执行后 exit 0，stdout 播报原因", async () => {
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
        expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("优雅关停：单测请求"));
    });

    it("单个钩子抛异常不阻断后续钩子", async () => {
        const mod = await freshShutdown();
        vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
        const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
        const order: string[] = [];
        mod.registerShutdownHook(() => {
            order.push("a");
        });
        mod.registerShutdownHook(() => {
            throw new Error("钩子炸了");
        });
        await mod.requestShutdown("单测请求");
        expect(order).toEqual(["a"]);
        expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("钩子炸了"));
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
