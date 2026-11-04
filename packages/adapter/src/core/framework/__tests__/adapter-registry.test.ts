/**
 * core/framework/adapter-registry.test.ts：适配器注册表单测。
 *
 * 锁定：register 按 protocol 键覆盖旧值、get 未注册返回 undefined、
 * startAll/stopAll 并发调用全部适配器。
 */
import { describe, expect, it, vi } from "vitest";
import { AdapterRegistry, type ProtocolAdapterLike } from "../adapter-registry.js";

/** 构造最小适配器（start/stop 可观察）。 */
function makeAdapter(protocol: string): ProtocolAdapterLike {
    return {
        protocol,
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
    };
}

describe("AdapterRegistry", () => {
    it("register + get：按 protocol 取回适配器", () => {
        const registry = new AdapterRegistry();
        const a = makeAdapter("satori");
        registry.register(a);
        expect(registry.get("satori")).toBe(a);
    });

    it("get 未注册协议：返回 undefined", () => {
        const registry = new AdapterRegistry();
        expect(registry.get("onebot11")).toBeUndefined();
    });

    it("重复注册同 protocol：覆盖旧适配器", () => {
        const registry = new AdapterRegistry();
        const first = makeAdapter("satori");
        const second = makeAdapter("satori");
        registry.register(first);
        registry.register(second);
        expect(registry.get("satori")).toBe(second);
    });

    it("startAll：调用全部适配器 start", async () => {
        const registry = new AdapterRegistry();
        const a = makeAdapter("onebot11");
        const b = makeAdapter("satori");
        registry.register(a);
        registry.register(b);
        await registry.startAll();
        expect(a.start).toHaveBeenCalledTimes(1);
        expect(b.start).toHaveBeenCalledTimes(1);
    });

    it("stopAll：调用全部适配器 stop", async () => {
        const registry = new AdapterRegistry();
        const a = makeAdapter("onebot11");
        const b = makeAdapter("satori");
        registry.register(a);
        registry.register(b);
        await registry.stopAll();
        expect(a.stop).toHaveBeenCalledTimes(1);
        expect(b.stop).toHaveBeenCalledTimes(1);
    });

    it("空注册表：startAll / stopAll 均为无操作", async () => {
        const registry = new AdapterRegistry();
        await expect(registry.startAll()).resolves.toBeUndefined();
        await expect(registry.stopAll()).resolves.toBeUndefined();
    });
});
