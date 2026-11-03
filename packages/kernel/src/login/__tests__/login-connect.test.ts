/**
 * login-connect.ts 基线测试（fallow 重构目标，untested risk）
 *
 * 覆盖快速登录纯逻辑：
 *  - pickLoginTarget：显式 uin 命中 / 未命中报错 / 缺省优先 quick / 空列表报错
 *  - isNetworkError：网络异常码 / 连接异常提示 / 其他错误
 *  - waitForNetworkConnection：loginService 形状校验
 *  - quickLogin 超时兜底（T3，2026-09-10）：底层 promise 永不 settle → 按配置超时
 *    → 抛登录失败；超时文案不触发网络重试
 */
import { describe, expect, it, vi } from "vitest";
import type { WrapperContext } from "../../wrapper/wrapper-loader.js";
import {
    isNetworkError,
    type LoginAccountInfo,
    pickLoginTarget,
    quickLogin,
    waitForNetworkConnection,
} from "../login-connect.js";

describe("pickLoginTarget", () => {
    const items: LoginAccountInfo[] = [
        { uin: "10001", uid: "u1", nickName: "A", isQuickLogin: false },
        { uin: "10002", uid: "u2", nickName: "B", isQuickLogin: true },
        { uin: "10003", uid: "u3", nickName: "C", isQuickLogin: true },
    ];

    it("显式 uin 命中返回对应账号", () => {
        expect(pickLoginTarget(items, "10002")).toEqual(items[1]);
    });

    it("显式 uin 未命中抛 NOT_FOUND", () => {
        expect(() => pickLoginTarget(items, "99999")).toThrow(/不在登录列表/);
    });

    it("未指定 uin 优先第一个可快速登录账号", () => {
        expect(pickLoginTarget(items, undefined)).toEqual(items[1]);
    });

    it("无快速登录账号时取列表第一个", () => {
        const noQuick = [{ uin: "10001", isQuickLogin: false }];
        expect(pickLoginTarget(noQuick, undefined)).toEqual(noQuick[0]);
    });

    it("空列表抛 NOT_LOGIN", () => {
        expect(() => pickLoginTarget([], undefined)).toThrow(/无可用登录账号/);
    });
});

describe("isNetworkError", () => {
    it("含 1006511 网络异常码", () => {
        expect(isNetworkError("错误码: 1006511")).toBe(true);
    });

    it("含登录系统连接异常提示", () => {
        expect(isNetworkError("登录系统连接异常")).toBe(true);
    });

    it("其他错误返回 false", () => {
        expect(isNetworkError("密码错误")).toBe(false);
        expect(isNetworkError("")).toBe(false);
    });

    it("快速登录超时文案不算网络错误（T3：避免 3 次重试 × 20s 叠挂）", () => {
        expect(isNetworkError("快速登录超时")).toBe(false);
        expect(isNetworkError("快速登录失败: 快速登录超时")).toBe(false);
    });
});

describe("waitForNetworkConnection", () => {
    it("loginService 缺失返回 false", async () => {
        const ctx = { loginService: null } as unknown as WrapperContext;
        await expect(waitForNetworkConnection(ctx)).resolves.toBe(false);
    });

    it("loginService 无 getMsfStatus 返回 false", async () => {
        const ctx = { loginService: {} } as unknown as WrapperContext;
        await expect(waitForNetworkConnection(ctx)).resolves.toBe(false);
    });
});

describe("quickLogin 超时兜底（T3 软重登挂起）", () => {
    /**
     * 构造走通 connect 阶段的假 loginService。
     * quickLogin 内部时序（模块私有常量，此处硬编码）：等 onLoginConnected
     * 兜底 15s（假 listener 不触发）→ 连接缓冲 3s → getLoginList → quickLoginWithUin。
     */
    function createQuickLoginCtx(overrides: Record<string, unknown> = {}) {
        const loginService = {
            getMsfStatus: vi.fn(() => 3),
            connect: vi.fn(),
            addKernelLoginListener: vi.fn(() => 1),
            getLoginList: vi.fn(async () => ({
                result: 0,
                LocalLoginInfoList: [
                    { uin: "10001", uid: "u1", nickName: "A", isQuickLogin: true },
                ],
            })),
            quickLoginWithUin: vi.fn(
                () =>
                    new Promise<{ result: string; loginErrorInfo: { errMsg: string } }>(() => {
                        // 永不 settle（T3 挂起场景默认值，用例按需覆写）
                    }),
            ),
            ...overrides,
        };
        return { ctx: { loginService } as unknown as WrapperContext, loginService };
    }

    /** connect 等待兜底（15s）+ 连接稳定缓冲（3s）。 */
    const ConnectPhaseMs = 18_000;

    it("quickLoginWithUin 永不 settle → 按配置超时 → 抛登录失败", async () => {
        vi.useFakeTimers();
        try {
            const { ctx, loginService } = createQuickLoginCtx();
            const promise = quickLogin(ctx, { quickLoginTimeoutMs: 1000 });
            await vi.advanceTimersByTimeAsync(ConnectPhaseMs);
            expect(loginService.quickLoginWithUin).toHaveBeenCalledTimes(1);

            const rejection = expect(promise).rejects.toThrow(/快速登录失败: 快速登录超时/);
            await vi.advanceTimersByTimeAsync(1_000);
            await rejection;
            // 超时文案非网络错误 → 不触发 1006511 重试（仍只调 1 次，不叠挂）
            expect(loginService.quickLoginWithUin).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it("getLoginList 永不 settle → 按配置超时 → 抛登录失败", async () => {
        vi.useFakeTimers();
        try {
            const { ctx } = createQuickLoginCtx({
                getLoginList: vi.fn(
                    () =>
                        new Promise<never>(() => {
                            // 永不 settle
                        }),
                ),
            });
            const promise = quickLogin(ctx, { quickLoginTimeoutMs: 1000 });
            await vi.advanceTimersByTimeAsync(ConnectPhaseMs);

            const rejection = expect(promise).rejects.toThrow(/快速登录失败: 快速登录超时/);
            await vi.advanceTimersByTimeAsync(1_000);
            await rejection;
        } finally {
            vi.useRealTimers();
        }
    });

    it("quickLoginWithUin 正常返回 → 不受超时影响", async () => {
        vi.useFakeTimers();
        try {
            const { ctx } = createQuickLoginCtx({
                quickLoginWithUin: vi.fn(async () => ({
                    result: "0",
                    loginErrorInfo: { errMsg: "" },
                })),
            });
            const promise = quickLogin(ctx, { uin: "10001", quickLoginTimeoutMs: 1000 });
            await vi.advanceTimersByTimeAsync(ConnectPhaseMs + 5_000);
            await expect(promise).resolves.toEqual({
                uin: "10001",
                uid: "u1",
                nick: "A",
            });
        } finally {
            vi.useRealTimers();
        }
    });
});
