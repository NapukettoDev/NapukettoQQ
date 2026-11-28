import { afterEach, describe, expect, it, vi } from "vitest";
import { NTEventChannel } from "../../src/infra/event-channel.js";

type TestListener = {
    onValue(value: number): void;
};

const VALUE_EVENT = "Test/onValue";
const WAIT_TIMEOUT_MS = 100;

describe("NTEventChannel", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it.each(["同步抛错", "异步拒绝"])("订阅者%s时仍向后续订阅者派发", async (mode) => {
        using channel = new NTEventChannel<TestListener, "Test">("Test");
        const error = new Error("subscriber failed");
        const received: number[] = [];
        const reported: unknown[] = [];
        channel.on(VALUE_EVENT, () => {
            if (mode === "同步抛错") {
                throw error;
            }
            return Promise.reject(error);
        });
        channel.on(VALUE_EVENT, (value) => {
            received.push(value);
        });
        channel.onError((err) => {
            reported.push(err);
        });

        channel.emit(VALUE_EVENT, 42);

        expect(received).toEqual([42]);
        await Promise.resolve();
        expect(reported).toEqual([error]);
    });

    it("waitFor 过滤事件，命中后移除临时订阅并清除计时器", async () => {
        vi.useFakeTimers();
        using channel = new NTEventChannel<TestListener, "Test">("Test");
        const filter = vi.fn((value: number) => value > 0);
        const waiting = channel.waitFor(VALUE_EVENT, { filter, timeout: WAIT_TIMEOUT_MS });

        channel.emit(VALUE_EVENT, 0);
        channel.emit(VALUE_EVENT, 42);

        await expect(waiting).resolves.toEqual([42]);
        expect(vi.getTimerCount()).toBe(0);
        channel.emit(VALUE_EVENT, 43);
        expect(filter.mock.calls).toEqual([[0], [42]]);
    });

    it("waitFor 超时抛 TIMEOUT 并移除临时订阅", async () => {
        vi.useFakeTimers();
        using channel = new NTEventChannel<TestListener, "Test">("Test");
        const filter = vi.fn((value: number) => value > 0);
        const waiting = channel.waitFor(VALUE_EVENT, { filter, timeout: WAIT_TIMEOUT_MS });
        channel.emit(VALUE_EVENT, 0);

        await Promise.all([
            expect(waiting).rejects.toMatchObject({ code: "TIMEOUT" }),
            vi.advanceTimersByTimeAsync(WAIT_TIMEOUT_MS),
        ]);
        expect(vi.getTimerCount()).toBe(0);
        channel.emit(VALUE_EVENT, 42);
        expect(filter.mock.calls).toEqual([[0]]);
    });
});
