/**
 * outbound-open.test.ts：出向传输首连容错的两个边界（issue #144 复查）
 *
 * - 取消竞态：stopAll/reload 在握手途中取消，open 随后才 resolve —— 必须立即
 *   close 已经建立的连接，不能留下无人管理的僵尸 WS。
 * - 重试定时器必须保持 ref：只配置正向 WS（无 server、heartbeat=0）时它是唯一
 *   维持事件循环的句柄，unref 会让宿主 code=0 提前退出。
 */
import type { TransportAdapter } from "@napuketto/network";
import { describe, expect, it, vi } from "vitest";
import type { AdapterLoggerLike } from "../../../src/internal/infra/log.js";
import { openOutboundWithRetry } from "../../../src/internal/infra/outbound-open.js";
import { stub } from "../stub.js";

/** 静默 logger 桩。 */
function silentLogger(): AdapterLoggerLike {
    return {
        warn: vi.fn<AdapterLoggerLike["warn"]>(),
        info: vi.fn<AdapterLoggerLike["info"]>(),
        debug: vi.fn<AdapterLoggerLike["debug"]>(),
    };
}

describe("openOutboundWithRetry（取消竞态）", () => {
    it("取消后 open 才 resolve → 立即 close，且不再排重试", async () => {
        let resolveOpen: (() => void) | undefined;
        const open = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    resolveOpen = resolve;
                }),
        );
        const close = vi.fn(async () => undefined);
        const transport = stub<TransportAdapter>({ open, close, send: vi.fn() });
        const cancel = openOutboundWithRetry(transport, {
            label: "onebot11 正向 WS ws://example.invalid",
            delayMs: 1000,
            logger: silentLogger(),
        });

        expect(open).toHaveBeenCalledTimes(1);
        // stopAll：取消时握手仍在途
        cancel();
        resolveOpen?.();
        await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));

        // 取消后不得再排重试（open 只发生首连这一次）
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(open).toHaveBeenCalledTimes(1);
    });
});

describe("openOutboundWithRetry（定时器 ref）", () => {
    it("重试定时器保持 ref（只配正向 WS 时事件循环不被清空）", async () => {
        let retryTimer: NodeJS.Timeout | undefined;
        const realSetTimeout = globalThis.setTimeout;
        const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
            handler: () => void,
            timeout?: number,
        ) => {
            const timer = realSetTimeout(handler, timeout);
            // 只捕获后台重试定时器（10s），不干扰 vi.waitFor 的内部轮询
            if (timeout === 10_000 && retryTimer === undefined) {
                retryTimer = timer;
            }
            return timer;
        }) as never);

        const transport = stub<TransportAdapter>({
            open: vi.fn(async () => {
                throw new Error("connect ECONNREFUSED 127.0.0.1:5140");
            }),
            close: vi.fn(async () => undefined),
            send: vi.fn(),
        });
        const cancel = openOutboundWithRetry(transport, {
            label: "onebot11 正向 WS ws://127.0.0.1:5140",
            delayMs: 10_000,
            logger: silentLogger(),
        });
        try {
            await vi.waitFor(() => expect(retryTimer).toBeDefined());
            // unref 过的 timer hasRef()=false → 宿主可能提前 code=0 退出
            expect(retryTimer?.hasRef()).toBe(true);
        } finally {
            cancel();
            setTimeoutSpy.mockRestore();
        }
    });
});
