/**
 * event-channel.ts 基线测试（fallow 重构目标，untested risk）
 *
 * 覆盖类型化事件通道的订阅/退订/派发/错误兜底：
 *  - on / onAny / onError 订阅与退订
 *  - emit 派发（含订阅者抛异常不打断后续派发）
 *  - waitFor 过滤与超时
 */
import { describe, expect, it, vi } from "vitest";
import { NTEventChannel } from "../event-channel.js";

/** 测试用 Listener 类型（type 别名：TS 对对象字面量做隐式索引签名，满足 ListenerShape 约束）。 */
type TestListener = {
    onFoo(arg: { n: number }): void;
    onBar(arg: string): void;
};

function makeChannel(): NTEventChannel<TestListener, "Test"> {
    return new NTEventChannel<TestListener, "Test">("Test");
}

describe("on / emit", () => {
    it("订阅后 emit 触发 handler", () => {
        const channel = makeChannel();
        const handler = vi.fn();
        channel.on("Test/onFoo", handler);
        channel.emit("Test/onFoo", { n: 1 });
        expect(handler).toHaveBeenCalledWith({ n: 1 });
    });

    it("退订后不再触发", () => {
        const channel = makeChannel();
        const handler = vi.fn();
        const off = channel.on("Test/onFoo", handler);
        off();
        channel.emit("Test/onFoo", { n: 1 });
        expect(handler).not.toHaveBeenCalled();
    });

    it("未订阅事件不报错", () => {
        const channel = makeChannel();
        expect(() => channel.emit("Test/onBar", "x")).not.toThrow();
    });
});

describe("emit 错误兜底", () => {
    it("订阅者抛异常不打断后续订阅者，且通知 onError", () => {
        const channel = makeChannel();
        const bad = vi.fn(() => {
            throw new Error("bad handler");
        });
        const good = vi.fn();
        const onError = vi.fn();
        channel.on("Test/onFoo", bad);
        channel.on("Test/onFoo", good);
        channel.onError(onError);
        channel.emit("Test/onFoo", { n: 1 });
        expect(good).toHaveBeenCalledWith({ n: 1 });
        expect(onError).toHaveBeenCalledTimes(1);
        const [firstArg] = onError.mock.calls[0] ?? [];
        expect((firstArg as Error).message).toBe("bad handler");
    });

    it("onAny 订阅者抛异常同样通知 onError 且不打断其他 onAny", () => {
        const channel = makeChannel();
        const bad = vi.fn(() => {
            throw new Error("bad any");
        });
        const good = vi.fn();
        const onError = vi.fn();
        channel.onAny(bad);
        channel.onAny(good);
        channel.onError(onError);
        channel.emit("Test/onBar", "x");
        expect(good).toHaveBeenCalledWith("Test/onBar", "x");
        expect(onError).toHaveBeenCalledTimes(1);
    });
});

describe("onAny / onError", () => {
    it("onAny 收到事件名与参数，退订后不再收到", () => {
        const channel = makeChannel();
        const handler = vi.fn();
        const off = channel.onAny(handler);
        channel.emit("Test/onFoo", { n: 1 });
        off();
        channel.emit("Test/onBar", "y");
        expect(handler).toHaveBeenCalledTimes(1);
    });

    it("onError 退订后不再收到", () => {
        const channel = makeChannel();
        const onError = vi.fn();
        const off = channel.onError(onError);
        off();
        channel.on("Test/onFoo", () => {
            throw new Error("x");
        });
        channel.emit("Test/onFoo", { n: 1 });
        expect(onError).not.toHaveBeenCalled();
    });
});

describe("waitFor", () => {
    it("命中 filter 后 resolve", async () => {
        const channel = makeChannel();
        const p = channel.waitFor("Test/onFoo", {
            filter: (arg) => arg.n > 0,
        });
        channel.emit("Test/onFoo", { n: 0 }); // 不匹配
        channel.emit("Test/onFoo", { n: 1 }); // 匹配
        await expect(p).resolves.toEqual([{ n: 1 }]);
    });

    it("超时 reject", async () => {
        const channel = makeChannel();
        const p = channel.waitFor("Test/onBar", { timeout: 30 });
        await expect(p).rejects.toThrow(/等待事件超时/);
    });
});
