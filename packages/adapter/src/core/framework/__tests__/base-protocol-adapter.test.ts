/**
 * core/framework/base-protocol-adapter.test.ts：适配器骨架生命周期单测。
 *
 * 锁定：start（校验配置 → onStart → started）/ stop（onStop）幂等语义、
 * 并发 start/stop 去重（共享同一次初始化/清理）、stop 等待进行中的 start、
 * reload 走 onReload（未 start 时 no-op 防状态不一致）、broadcastEvent 无
 * broadcaster 不抛错、getBroadcaster 透出。
 */

import type { ConfigBase } from "@napuketto/kernel";
import type { EventBroadcaster } from "@napuketto/network";
import { describe, expect, it, vi } from "vitest";
import { stub } from "../../../shared/__tests__/stub.js";
import { BaseProtocolAdapter } from "../base-protocol-adapter.js";

/** 记录钩子调用的测试适配器（公开包装 protected 成员供断言）。 */
class TestAdapter extends BaseProtocolAdapter<{ enabled: boolean }> {
    readonly protocol = "test";

    readonly calls: string[] = [];

    constructor(config: ConfigBase<{ enabled: boolean }>, broadcaster?: EventBroadcaster) {
        super({
            config,
            ...(broadcaster !== undefined ? { broadcaster } : {}),
            hooks: {
                onStart: async (config) => {
                    this.calls.push(`start:${(config as { enabled: boolean }).enabled}`);
                },
                onStop: async () => {
                    this.calls.push("stop");
                },
                onReload: async (config) => {
                    this.calls.push(`reload:${(config as { enabled: boolean }).enabled}`);
                },
            },
        });
    }

    /** 公开广播入口（测试 protected broadcastEvent）。 */
    emitTest(event: unknown): void {
        this.broadcastEvent(event);
    }

    /** 公开读取广播器（测试 protected getBroadcaster）。 */
    readBroadcaster(): EventBroadcaster | undefined {
        return this.getBroadcaster();
    }
}

/** 最小 ConfigBase 桩（只实现 load）。 */
function stubConfig(loadImpl: () => Promise<{ enabled: boolean }>): ConfigBase<{
    enabled: boolean;
}> {
    return stub<ConfigBase<{ enabled: boolean }>>({ load: loadImpl });
}

describe("BaseProtocolAdapter 生命周期", () => {
    it("start：load 配置 → onStart；二次 start 幂等跳过", async () => {
        const config = stubConfig(vi.fn(async () => ({ enabled: true })));
        const adapter = new TestAdapter(config);
        await adapter.start();
        expect(config.load).toHaveBeenCalledTimes(1);
        expect(adapter.calls).toEqual(["start:true"]);
        await adapter.start();
        expect(config.load).toHaveBeenCalledTimes(1); // 幂等：不重复 load
        expect(adapter.calls).toEqual(["start:true"]);
    });

    it("stop 未 start：直接跳过（不调 onStop）", async () => {
        const adapter = new TestAdapter(stubConfig(async () => ({ enabled: false })));
        await adapter.stop();
        expect(adapter.calls).toEqual([]);
    });

    it("start → stop：onStop 执行；stop 后再 stop 幂等", async () => {
        const adapter = new TestAdapter(stubConfig(async () => ({ enabled: true })));
        await adapter.start();
        await adapter.stop();
        expect(adapter.calls).toEqual(["start:true", "stop"]);
        await adapter.stop();
        expect(adapter.calls).toEqual(["start:true", "stop"]);
        // stop 后可重新 start
        await adapter.start();
        expect(adapter.calls).toEqual(["start:true", "stop", "start:true"]);
    });

    it("reload：重新 load → onReload（不改变 started 状态）", async () => {
        const load = vi.fn(async () => ({ enabled: true }));
        const adapter = new TestAdapter(stubConfig(load));
        await adapter.start();
        await adapter.reload();
        expect(load).toHaveBeenCalledTimes(2);
        expect(adapter.calls).toEqual(["start:true", "reload:true"]);
        // reload 后仍处于 started：stop 正常执行
        await adapter.stop();
        expect(adapter.calls).toEqual(["start:true", "reload:true", "stop"]);
    });
});

describe("BaseProtocolAdapter 并发与状态一致性", () => {
    it("并发 start ×3：onStart 只执行一次（共享进行中的初始化）", async () => {
        const load = vi.fn(async () => ({ enabled: true }));
        const adapter = new TestAdapter(stubConfig(load));
        await Promise.all([adapter.start(), adapter.start(), adapter.start()]);
        expect(load).toHaveBeenCalledTimes(1);
        expect(adapter.calls).toEqual(["start:true"]);
    });

    it("并发 stop ×2：onStop 只执行一次", async () => {
        const adapter = new TestAdapter(stubConfig(async () => ({ enabled: true })));
        await adapter.start();
        await Promise.all([adapter.stop(), adapter.stop()]);
        expect(adapter.calls).toEqual(["start:true", "stop"]);
    });

    it("stop 在 start 进行中调用：等 start 落地后再清理（不空转）", async () => {
        let release!: () => void;
        const gated = new Promise<{ enabled: boolean }>((resolve) => {
            release = () => resolve({ enabled: true });
        });
        const load = vi.fn(() => gated);
        const adapter = new TestAdapter(stubConfig(load));
        const startPromise = adapter.start();
        // start 尚未落地（load 挂起）：stop 等待而非直接跳过
        const stopPromise = adapter.stop();
        release();
        await Promise.all([startPromise, stopPromise]);
        expect(adapter.calls).toEqual(["start:true", "stop"]);
    });

    it("reload 未 start：no-op（onReload 不执行、不 load），后续 stop 不空转", async () => {
        // 回归：reload 在未启动实例上执行 onReload（停旧传输 + 重建）会留下
        // 「传输已启动但 started=false、后续 stop() 空转」的状态不一致
        const load = vi.fn(async () => ({ enabled: true }));
        const adapter = new TestAdapter(stubConfig(load));
        await adapter.reload();
        expect(adapter.calls).toEqual([]);
        expect(load).toHaveBeenCalledTimes(0);
        await adapter.stop();
        expect(adapter.calls).toEqual([]);
    });

    it("start 失败 → started 保持 false：stop 不调 onStop，可重试 start", async () => {
        let attempt = 0;
        const load = vi.fn(async () => {
            attempt += 1;
            if (attempt === 1) {
                throw new Error("配置读取失败");
            }
            return { enabled: true };
        });
        const adapter = new TestAdapter(stubConfig(load));
        await expect(adapter.start()).rejects.toThrow("配置读取失败");
        expect(adapter.calls).toEqual([]);
        await adapter.stop();
        expect(adapter.calls).toEqual([]);
        await adapter.start();
        expect(adapter.calls).toEqual(["start:true"]);
    });
});

describe("BaseProtocolAdapter 广播", () => {
    it("有 broadcaster：broadcastEvent 透传 emit", () => {
        const emitted: unknown[] = [];
        const broadcaster = stub<EventBroadcaster>({
            emit: (e: unknown) => {
                emitted.push(e);
            },
        });
        const adapter = new TestAdapter(
            stubConfig(async () => ({ enabled: true })),
            broadcaster,
        );
        adapter.emitTest({ type: "x" });
        expect(emitted).toEqual([{ type: "x" }]);
        expect(adapter.readBroadcaster()).toBe(broadcaster);
    });

    it("无 broadcaster：broadcastEvent / getBroadcaster 安全降级", () => {
        const adapter = new TestAdapter(stubConfig(async () => ({ enabled: true })));
        expect(() => adapter.emitTest({ type: "x" })).not.toThrow();
        expect(adapter.readBroadcaster()).toBeUndefined();
    });
});
