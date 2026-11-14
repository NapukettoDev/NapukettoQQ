/**
 * core/framework/base-protocol-adapter.test.ts：适配器骨架生命周期单测。
 *
 * 锁定：start（校验配置 → onStart → started）/ stop（onStop）幂等语义、
 * reload 走 onReload、broadcastEvent 无 broadcaster 不抛错、getBroadcaster 透出。
 */
import type { EventBroadcaster } from "@napuketto/network";
import { describe, expect, it, vi } from "vitest";
import { stub } from "../../__tests__/stub.js";
import { BaseProtocolAdapter } from "../base-protocol-adapter.js";
import type { ProtocolConfig } from "../config.js";

/** 记录钩子调用的测试适配器（公开包装 protected 成员供断言）。 */
class TestAdapter extends BaseProtocolAdapter<{ enabled: boolean }> {
    readonly protocol = "test";

    readonly calls: string[] = [];

    constructor(config: ProtocolConfig<{ enabled: boolean }>, broadcaster?: EventBroadcaster) {
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

/** 最小 ProtocolConfig 桩（只实现 load）。 */
function stubConfig(loadImpl: () => Promise<{ enabled: boolean }>): ProtocolConfig<{
    enabled: boolean;
}> {
    return stub<ProtocolConfig<{ enabled: boolean }>>({ load: loadImpl });
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
