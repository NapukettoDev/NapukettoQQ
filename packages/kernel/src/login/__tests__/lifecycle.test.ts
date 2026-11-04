/**
 * lifecycle.ts 测试：session 就绪等待与初始化编排（全 mock，不碰真实 wrapper）：
 *  - waitSessionReady：session 未创建抛 INVALID_STATE / getMsgService 就绪 /
 *    null（超时 TIMEOUT）/ getter 抛错按未就绪处理
 *  - initAndStartSession：session 未创建 / init 完成信号（onOpentelemetryInit 主 /
 *    onSessionInitComplete 辅，"0" 字符串同义）/ init 失败码抛 UNKNOWN / 超时 TIMEOUT
 *  - 启动分支：startupSession.start() 优先 / 回退 startNT(0) / startNT 降级与静默
 *  - init 原监听回调保留（wrapper 原回调不被覆盖丢弃）
 */
import { describe, expect, it, vi } from "vitest";
import type {
    NodeIKernelSessionListener,
    NodeIQQNTWrapperSession,
    WrapperSessionInitConfig,
} from "../../types/index.js";
import type { WrapperContext } from "../../wrapper/wrapper-loader.js";
import { initAndStartSession, waitSessionReady } from "../lifecycle.js";

/** 构造 ctx（session / startupSession 可覆写）。 */
function makeCtx(overrides: Record<string, unknown> = {}): WrapperContext {
    return {
        session: null,
        startupSession: null,
        ...overrides,
    } as unknown as WrapperContext;
}

/** 构造 session 桩。 */
function makeSession(initSpy?: (...args: unknown[]) => void): NodeIQQNTWrapperSession {
    return {
        getMsgService: () => ({}),
        init: vi.fn((...args: unknown[]) => {
            initSpy?.(...args);
        }),
        startNT: vi.fn(),
    } as unknown as NodeIQQNTWrapperSession;
}

/** 构造 listener 桩（回调可手动触发）。 */
function makeListener() {
    const listener: Record<string, ((...args: unknown[]) => void) | undefined> = {};
    return listener as unknown as NodeIKernelSessionListener & Record<string, unknown>;
}

/** 最小 init 配置（initAndStartSession 只透传）。 */
const config = { accountPath: "p", downloadPath: "d" } as unknown as WrapperSessionInitConfig;

describe("waitSessionReady", () => {
    it("session 未创建（null）抛 INVALID_STATE", async () => {
        await expect(waitSessionReady(makeCtx({ session: null }), {})).rejects.toMatchObject({
            code: "INVALID_STATE",
            message: /session 未创建/,
        });
    });

    it("session undefined 同样抛 INVALID_STATE", async () => {
        await expect(waitSessionReady(makeCtx({ session: undefined }), {})).rejects.toMatchObject({
            code: "INVALID_STATE",
        });
    });

    it("getMsgService 立即非空 → resolve", async () => {
        const ctx = makeCtx({ session: makeSession() });
        await expect(waitSessionReady(ctx, {})).resolves.toBeUndefined();
    });

    it("getMsgService 恒 null → 超时 TIMEOUT（fake timers 加速）", async () => {
        vi.useFakeTimers();
        try {
            const session = { getMsgService: () => null } as unknown as NodeIQQNTWrapperSession;
            const ctx = makeCtx({ session });
            const promise = waitSessionReady(ctx, {});
            const assertion = expect(promise).rejects.toMatchObject({ code: "TIMEOUT" });
            await vi.advanceTimersByTimeAsync(31_000);
            await assertion;
        } finally {
            vi.useRealTimers();
        }
    });

    it("getMsgService 抛错按未就绪处理（轮询到超时）", async () => {
        vi.useFakeTimers();
        try {
            const session = {
                getMsgService: () => {
                    throw new Error("not init");
                },
            } as unknown as NodeIQQNTWrapperSession;
            const ctx = makeCtx({ session });
            const promise = waitSessionReady(ctx, { timeoutMs: 2000 });
            const assertion = expect(promise).rejects.toMatchObject({ code: "TIMEOUT" });
            await vi.advanceTimersByTimeAsync(3_000);
            await assertion;
        } finally {
            vi.useRealTimers();
        }
    });

    it("轮询中途就绪 → resolve（null 若干次后返回 service）", async () => {
        vi.useFakeTimers();
        try {
            let calls = 0;
            const session = {
                getMsgService: () => {
                    calls += 1;
                    return calls >= 3 ? ({} as unknown) : null;
                },
            } as unknown as NodeIQQNTWrapperSession;
            const ctx = makeCtx({ session });
            const promise = waitSessionReady(ctx, {});
            await vi.advanceTimersByTimeAsync(5_000);
            await expect(promise).resolves.toBeUndefined();
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("initAndStartSession", () => {
    it("session 未创建抛 INVALID_STATE", async () => {
        const ctx = makeCtx({ session: null });
        await expect(initAndStartSession(ctx, config, makeListener(), {})).rejects.toMatchObject({
            code: "INVALID_STATE",
        });
    });

    it("onOpentelemetryInit(is_init=true) 主信号完成 → init+start 调用顺序正确", async () => {
        const calls: string[] = [];
        const session = makeSession(() => calls.push("init"));
        const startupSession = { start: vi.fn(() => calls.push("start")) };
        const ctx = makeCtx({ session, startupSession });
        const listener = makeListener();
        const promise = initAndStartSession(ctx, config, listener, {});
        // init 同步触发回调注册后，模拟原生回调
        listener["onOpentelemetryInit"]?.({ is_init: true } as never);
        await expect(promise).resolves.toBeUndefined();
        expect(calls).toEqual(["init", "start"]);
    });

    it("onSessionInitComplete(0) 辅信号完成（主信号未触发）", async () => {
        const ctx = makeCtx({ session: makeSession() });
        const listener = makeListener();
        const promise = initAndStartSession(ctx, config, listener, {});
        listener["onSessionInitComplete"]?.(0 as never);
        await expect(promise).resolves.toBeUndefined();
    });

    it("onSessionInitComplete('0') 字符串形态同义完成", async () => {
        const ctx = makeCtx({ session: makeSession() });
        const listener = makeListener();
        const promise = initAndStartSession(ctx, config, listener, {});
        listener["onSessionInitComplete"]?.("0" as never);
        await expect(promise).resolves.toBeUndefined();
    });

    it("onSessionInitComplete 非 0 → 抛 UNKNOWN（init 失败码）", async () => {
        const ctx = makeCtx({ session: makeSession() });
        const listener = makeListener();
        const promise = initAndStartSession(ctx, config, listener, {});
        listener["onSessionInitComplete"]?.(-1 as never);
        await expect(promise).rejects.toMatchObject({
            code: "UNKNOWN",
            message: /session init 失败/,
        });
    });

    it("无完成信号 → 超时 TIMEOUT", async () => {
        vi.useFakeTimers();
        try {
            const ctx = makeCtx({ session: makeSession() });
            const promise = initAndStartSession(ctx, config, makeListener(), {});
            const assertion = expect(promise).rejects.toMatchObject({
                code: "TIMEOUT",
                message: /session init 超时/,
            });
            await vi.advanceTimersByTimeAsync(16_000);
            await assertion;
        } finally {
            vi.useRealTimers();
        }
    });

    it("init 前已有的原 onOpentelemetryInit 回调保留（覆盖不丢弃）", async () => {
        const ctx = makeCtx({ session: makeSession() });
        const listener = makeListener();
        const original = vi.fn();
        listener["onOpentelemetryInit"] = original;
        const promise = initAndStartSession(ctx, config, listener, {});
        listener["onOpentelemetryInit"]?.({ is_init: false } as never);
        listener["onOpentelemetryInit"]?.({ is_init: true } as never);
        await expect(promise).resolves.toBeUndefined();
        expect(original).toHaveBeenCalledTimes(2);
    });

    it("onSessionInitComplete 完成后原回调也保留", async () => {
        const ctx = makeCtx({ session: makeSession() });
        const listener = makeListener();
        const original = vi.fn();
        listener["onSessionInitComplete"] = original;
        const promise = initAndStartSession(ctx, config, listener, {});
        listener["onSessionInitComplete"]?.(0 as never);
        await expect(promise).resolves.toBeUndefined();
        expect(original).toHaveBeenCalledWith(0);
    });
});

describe("启动分支（startSessionBestEffort）", () => {
    it("startupSession.start 存在 → 优先使用，startNT 不调用", async () => {
        const session = makeSession();
        const startupSession = { start: vi.fn() };
        const ctx = makeCtx({ session, startupSession });
        const listener = makeListener();
        const promise = initAndStartSession(ctx, config, listener, {});
        listener["onOpentelemetryInit"]?.({ is_init: true } as never);
        await promise;
        expect(startupSession.start).toHaveBeenCalledTimes(1);
        expect(session.startNT).not.toHaveBeenCalled();
    });

    it("startupSession 缺失 → startNT(0)", async () => {
        const session = makeSession();
        const ctx = makeCtx({ session, startupSession: null });
        const listener = makeListener();
        const promise = initAndStartSession(ctx, config, listener, {});
        listener["onOpentelemetryInit"]?.({ is_init: true } as never);
        await promise;
        expect(session.startNT).toHaveBeenCalledWith(0);
    });

    it("startupSession.start 非 function → 视为缺失走 startNT(0)", async () => {
        const session = makeSession();
        const ctx = makeCtx({ session, startupSession: { start: "nope" } });
        const listener = makeListener();
        const promise = initAndStartSession(ctx, config, listener, {});
        listener["onOpentelemetryInit"]?.({ is_init: true } as never);
        await promise;
        expect(session.startNT).toHaveBeenCalledWith(0);
    });

    it("startupSession.start 抛错不致命（继续等信号）", async () => {
        const session = makeSession();
        const startupSession = {
            start: vi.fn(() => {
                throw new Error("start crash");
            }),
        };
        const ctx = makeCtx({ session, startupSession });
        const listener = makeListener();
        const promise = initAndStartSession(ctx, config, listener, {});
        listener["onOpentelemetryInit"]?.({ is_init: true } as never);
        await expect(promise).resolves.toBeUndefined();
    });

    it("startNT(0) 抛错降级 startNT()（老版本签名兼容）", async () => {
        const session = makeSession();
        const startNT = session.startNT as unknown as ReturnType<typeof vi.fn>;
        startNT.mockImplementation((arg?: number) => {
            if (arg !== undefined) {
                throw new Error("bad arity");
            }
        });
        const ctx = makeCtx({ session, startupSession: null });
        const listener = makeListener();
        const promise = initAndStartSession(ctx, config, listener, {});
        listener["onOpentelemetryInit"]?.({ is_init: true } as never);
        await expect(promise).resolves.toBeUndefined();
        expect(startNT).toHaveBeenCalledWith(0);
        expect(startNT).toHaveBeenLastCalledWith();
    });

    it("无 startNT 方法（9.9.31 形态）静默等待 init 信号", async () => {
        const session = {
            getMsgService: () => ({}),
            init: vi.fn(),
        } as unknown as NodeIQQNTWrapperSession;
        const ctx = makeCtx({ session, startupSession: null });
        const listener = makeListener();
        const promise = initAndStartSession(ctx, config, listener, {});
        listener["onOpentelemetryInit"]?.({ is_init: true } as never);
        await expect(promise).resolves.toBeUndefined();
    });

    it("startNT(0)/startNT() 均抛错 → 静默等待 init 信号", async () => {
        const session = makeSession();
        const startNT = session.startNT as unknown as ReturnType<typeof vi.fn>;
        startNT.mockImplementation(() => {
            throw new Error("no startNT");
        });
        const ctx = makeCtx({ session, startupSession: null });
        const listener = makeListener();
        const promise = initAndStartSession(ctx, config, listener, {});
        listener["onSessionInitComplete"]?.(0 as never);
        await expect(promise).resolves.toBeUndefined();
    });
});
