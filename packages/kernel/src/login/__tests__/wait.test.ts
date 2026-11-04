/**
 * wait.ts 测试：waitFor 轮询/超时 + sleep。
 * 时间相关用 fake timers（进/出成对）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sleep, waitFor } from "../wait.js";

describe("waitFor", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("条件立即满足 → true（不启动定时器）", async () => {
        const promise = waitFor(() => true, 1000, 100);
        await vi.advanceTimersByTimeAsync(0);
        await expect(promise).resolves.toBe(true);
    });

    it("轮询若干次后条件满足 → true", async () => {
        let count = 0;
        const promise = waitFor(
            () => {
                count += 1;
                return count >= 3;
            },
            5000,
            100,
        );
        await vi.advanceTimersByTimeAsync(300);
        await expect(promise).resolves.toBe(true);
        expect(count).toBeGreaterThanOrEqual(3);
    });

    it("超时未满足 → false", async () => {
        const promise = waitFor(() => false, 500, 100);
        await vi.advanceTimersByTimeAsync(700);
        await expect(promise).resolves.toBe(false);
    });

    it("自定义轮询间隔生效（500ms 间隔下 1.6s 内 tick 有限次）", async () => {
        let ticks = 0;
        const promise = waitFor(
            () => {
                ticks += 1;
                return false;
            },
            1000,
            500,
        );
        // 超时判定 Date.now() - started > 1000 在 1500ms 边界才成立（严格大于）
        await vi.advanceTimersByTimeAsync(1600);
        await expect(promise).resolves.toBe(false);
        // 起始 1 次 + 3 次轮询 = 4 次（间隔 500ms 生效，未按默认 500 挤满）
        expect(ticks).toBeLessThanOrEqual(4);
    });
});

describe("sleep", () => {
    it("指定毫秒后 resolve", async () => {
        vi.useFakeTimers();
        try {
            const promise = sleep(300);
            const assertion = expect(promise).resolves.toBeUndefined();
            await vi.advanceTimersByTimeAsync(300);
            await assertion;
        } finally {
            vi.useRealTimers();
        }
    });
});
