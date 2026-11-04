/**
 * EventBroadcaster（泛型广播总线）测试
 *
 * 锁定：register 幂等、unregister 移除、emit 广播到全部适配器、
 * 单适配器抛错不中断后续（容错语义）、openAll/closeAll 生命周期派发、
 * 空集合与未注册成员的边界。
 */
import { describe, expect, it } from "vitest";
import { EventBroadcaster } from "../broadcaster.js";
import type { TransportAdapter } from "../types.js";

/** 构造记录 send 调用的适配器桩。 */
function makeAdapter(): TransportAdapter & { sent: unknown[] } {
    const sent: unknown[] = [];
    return {
        sent,
        send: <T>(payload: T) => {
            sent.push(payload);
        },
        open: () => undefined,
        close: () => undefined,
    };
}

/** 构造 send 必抛的适配器桩（容错用例）。 */
function makeBrokenAdapter(): TransportAdapter {
    return {
        send: <T>(_payload: T) => {
            throw new Error("send 崩溃");
        },
        open: () => undefined,
        close: () => undefined,
    };
}

describe("EventBroadcaster", () => {
    it("emit 广播同一事件引用给全部已注册适配器", () => {
        const bus = new EventBroadcaster();
        const a = makeAdapter();
        const b = makeAdapter();
        bus.register(a);
        bus.register(b);

        const event = { type: "message", id: 1 };
        bus.emit(event);

        expect(a.sent).toEqual([event]);
        expect(b.sent).toEqual([event]);
        expect(b.sent[0]).toBe(event);
    });

    it("重复注册幂等（同一适配器只收到一份）", () => {
        const bus = new EventBroadcaster();
        const a = makeAdapter();
        bus.register(a);
        bus.register(a);
        expect(bus.size).toBe(1);

        bus.emit("x");
        expect(a.sent).toEqual(["x"]);
    });

    it("unregister 后不再收到广播", () => {
        const bus = new EventBroadcaster();
        const a = makeAdapter();
        bus.register(a);
        bus.unregister(a);

        bus.emit("gone");
        expect(a.sent).toEqual([]);
        expect(bus.size).toBe(0);
    });

    it("unregister 未注册的适配器不抛错、不影响 size", () => {
        const bus = new EventBroadcaster();
        const a = makeAdapter();
        expect(() => bus.unregister(a)).not.toThrow();
        expect(bus.size).toBe(0);
    });

    it("无适配器时 emit 安全（no-op）", () => {
        const bus = new EventBroadcaster();
        expect(() => bus.emit({ any: "payload" })).not.toThrow();
    });

    it("size 反映当前注册数量", () => {
        const bus = new EventBroadcaster();
        expect(bus.size).toBe(0);
        const a = makeAdapter();
        const b = makeAdapter();
        bus.register(a);
        bus.register(b);
        expect(bus.size).toBe(2);
        bus.unregister(a);
        expect(bus.size).toBe(1);
    });

    it("单个适配器 send 抛错不影响其余适配器收到事件", () => {
        const bus = new EventBroadcaster();
        const broken = makeBrokenAdapter();
        const healthy = makeAdapter();
        bus.register(broken);
        bus.register(healthy);

        expect(() => bus.emit("survives")).not.toThrow();
        expect(healthy.sent).toEqual(["survives"]);
    });

    it("emit 为泛型：任意载荷类型透传（不收窄）", () => {
        const bus = new EventBroadcaster();
        const a = makeAdapter();
        bus.register(a);

        const nested = { list: [1, 2, 3], meta: { ok: true } };
        bus.emit(nested);
        expect(a.sent[0]).toEqual({ list: [1, 2, 3], meta: { ok: true } });
    });

    it("openAll 并发启动全部适配器（等待全部 resolve）", async () => {
        const bus = new EventBroadcaster();
        const opened: string[] = [];
        const adapter = (name: string): TransportAdapter => ({
            send: () => undefined,
            open: () =>
                new Promise<void>((resolve) => {
                    setTimeout(() => {
                        opened.push(name);
                        resolve();
                    }, 5);
                }),
            close: () => undefined,
        });
        bus.register(adapter("a"));
        bus.register(adapter("b"));

        await bus.openAll();
        expect(opened.sort()).toEqual(["a", "b"]);
    });

    it("closeAll 并发关闭全部适配器", async () => {
        const bus = new EventBroadcaster();
        const closed: string[] = [];
        const adapter = (name: string): TransportAdapter => ({
            send: () => undefined,
            open: () => undefined,
            close: () => {
                closed.push(name);
            },
        });
        bus.register(adapter("a"));
        bus.register(adapter("b"));

        await bus.closeAll();
        expect(closed.sort()).toEqual(["a", "b"]);
    });

    it("openAll 等待异步 open 的真实完成（Promise 语义）", async () => {
        const bus = new EventBroadcaster();
        let resolved = false;
        bus.register({
            send: () => undefined,
            open: () =>
                new Promise<void>((resolve) => {
                    resolve();
                    resolved = true;
                }),
            close: () => undefined,
        });
        await bus.openAll();
        expect(resolved).toBe(true);
    });
});
