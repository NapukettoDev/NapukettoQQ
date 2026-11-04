// biome-ignore-all lint/style/useNamingConvention: 对象键名为 QQ wrapper.node 真实导出名（PascalCase），必须原样保留
/**
 * login-connect.ts 扩展测试（基线 pickLoginTarget/isNetworkError/超时兜底之外）：
 *  - listLoginAccounts：service 无效抛错 / 列表返回
 *  - quickLogin 入口分支：loginService null / 空历史列表 / 显式 uin 不在列表
 *  - 网络异常重试（1006511）：重试后成功 / 重试耗尽抛 NOT_LOGIN /
 *    网络未就绪中断重试
 *  - ensureLoginConnected 分支：无 connect 跳过 / connect 抛错继续 /
 *    onLoginConnected 触发提前进入（不等 15s 兜底）/ 监听注册失败不阻塞
 *  - waitForNetworkConnection：就绪 true / 超时 false / getMsfStatus 抛错容忍
 */
import { describe, expect, it, vi } from "vitest";
import type { WrapperContext } from "../../wrapper/wrapper-loader.js";
import {
    isNetworkError,
    type LoginAccountInfo,
    listLoginAccounts,
    pickLoginTarget,
    quickLogin,
    waitForNetworkConnection,
} from "../login-connect.js";

/** connect 阶段总时长（等连接兜底 15s + 缓冲 3s，listener 触发时为缓冲 3s）。 */
const ConnectPhaseMs = 18_000;

/** 构造走通 connect 阶段的假 loginService。 */
function createCtx(overrides: Record<string, unknown> = {}) {
    const loginService = {
        getMsfStatus: vi.fn(() => 3),
        connect: vi.fn(),
        addKernelLoginListener: vi.fn((listener: Record<string, unknown>) => {
            // 记录 listener 供用例手动触发 onLoginConnected
            (loginService as { __listener?: Record<string, unknown> }).__listener = listener;
            return 1;
        }),
        getLoginList: vi.fn(async () => ({
            result: 0,
            LocalLoginInfoList: [
                { uin: "10001", uid: "u1", nickName: "A", isQuickLogin: true },
            ] satisfies LoginAccountInfo[],
        })),
        quickLoginWithUin: vi.fn(async () => ({
            result: "0",
            loginErrorInfo: { errMsg: "" },
        })),
        ...overrides,
    };
    return { ctx: { loginService } as unknown as WrapperContext, loginService };
}

describe("listLoginAccounts", () => {
    it("loginService null 抛 INVALID_STATE", async () => {
        const ctx = { loginService: null } as unknown as WrapperContext;
        await expect(listLoginAccounts(ctx)).rejects.toMatchObject({
            code: "INVALID_STATE",
            message: /loginService 无效/,
        });
    });

    it("返回 LocalLoginInfoList", async () => {
        const items: LoginAccountInfo[] = [{ uin: "10001", isQuickLogin: true }];
        const { ctx } = createCtx({
            getLoginList: vi.fn(async () => ({ result: 0, LocalLoginInfoList: items })),
        });
        await expect(listLoginAccounts(ctx)).resolves.toEqual(items);
    });
});

describe("quickLogin 入口分支", () => {
    it("loginService null 抛 INVALID_STATE（不触网）", async () => {
        const ctx = { loginService: null } as unknown as WrapperContext;
        await expect(quickLogin(ctx)).rejects.toMatchObject({ code: "INVALID_STATE" });
    });

    it("无历史登录账号 → NOT_LOGIN", async () => {
        vi.useFakeTimers();
        try {
            const { ctx } = createCtx({
                getLoginList: vi.fn(async () => ({ result: 0, LocalLoginInfoList: [] })),
            });
            const promise = quickLogin(ctx);
            const rejection = expect(promise).rejects.toMatchObject({
                code: "NOT_LOGIN",
                message: /无历史登录账号/,
            });
            await vi.advanceTimersByTimeAsync(ConnectPhaseMs);
            await rejection;
        } finally {
            vi.useRealTimers();
        }
    });

    it("显式 uin 不在列表 → NOT_FOUND（不得静默 fallback 别的号）", async () => {
        vi.useFakeTimers();
        try {
            const { ctx } = createCtx();
            const promise = quickLogin(ctx, { uin: "99999" });
            const rejection = expect(promise).rejects.toMatchObject({
                code: "NOT_FOUND",
                message: /99999 不在登录列表/,
            });
            await vi.advanceTimersByTimeAsync(ConnectPhaseMs);
            await rejection;
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("网络异常重试（1006511）", () => {
    it("首次网络异常 → 等网络就绪 → 重试成功", async () => {
        vi.useFakeTimers();
        try {
            let attempt = 0;
            const { ctx, loginService } = createCtx({
                quickLoginWithUin: vi.fn(async () => {
                    attempt += 1;
                    if (attempt === 1) {
                        return { result: "1", loginErrorInfo: { errMsg: "错误码: 1006511" } };
                    }
                    return { result: "0", loginErrorInfo: { errMsg: "" } };
                }),
            });
            const promise = quickLogin(ctx, { quickLoginTimeoutMs: 5000 });
            // 连接阶段（18s）内：尝试 1 失败（1006511）→ 网络立即就绪 → 重试成功
            await vi.advanceTimersByTimeAsync(ConnectPhaseMs + 5_000);
            await expect(promise).resolves.toEqual({ uin: "10001", uid: "u1", nick: "A" });
            expect(loginService.quickLoginWithUin).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it("三次网络异常重试耗尽 → NOT_LOGIN", async () => {
        vi.useFakeTimers();
        try {
            const { ctx, loginService } = createCtx({
                quickLoginWithUin: vi.fn(async () => ({
                    result: "1",
                    loginErrorInfo: { errMsg: "1006511" },
                })),
            });
            const promise = quickLogin(ctx, { quickLoginTimeoutMs: 5000 });
            const rejection = expect(promise).rejects.toMatchObject({ code: "NOT_LOGIN" });
            await vi.advanceTimersByTimeAsync(ConnectPhaseMs + 60_000);
            await rejection;
            // 初次 + 2 次重试 = 3 次（上限）
            expect(loginService.quickLoginWithUin).toHaveBeenCalledTimes(3);
        } finally {
            vi.useRealTimers();
        }
    });

    it("连接异常提示同样触发重试；网络未就绪（false）则中断重试", async () => {
        vi.useFakeTimers();
        try {
            const { ctx, loginService } = createCtx({
                getMsfStatus: vi.fn(() => 0),
                quickLoginWithUin: vi.fn(async () => ({
                    result: "1",
                    loginErrorInfo: { errMsg: "登录系统连接异常" },
                })),
            });
            const promise = quickLogin(ctx, { quickLoginTimeoutMs: 5000, timeoutMs: 2000 });
            const rejection = expect(promise).rejects.toMatchObject({ code: "NOT_LOGIN" });
            await vi.advanceTimersByTimeAsync(ConnectPhaseMs + 60_000);
            await rejection;
            // 初次尝试后网络始终未就绪（超时 false）→ 不再重试
            expect(loginService.quickLoginWithUin).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it("非网络错误（如密码错误）不重试", async () => {
        vi.useFakeTimers();
        try {
            const { ctx, loginService } = createCtx({
                quickLoginWithUin: vi.fn(async () => ({
                    result: "1",
                    loginErrorInfo: { errMsg: "密码错误" },
                })),
            });
            const promise = quickLogin(ctx, { quickLoginTimeoutMs: 5000 });
            const rejection = expect(promise).rejects.toMatchObject({
                message: /快速登录失败: 密码错误/,
            });
            await vi.advanceTimersByTimeAsync(ConnectPhaseMs + 5_000);
            await rejection;
            expect(loginService.quickLoginWithUin).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("ensureLoginConnected 分支", () => {
    it("onLoginConnected 触发 → 跳过 15s 兜底，只等 3s 缓冲", async () => {
        vi.useFakeTimers();
        try {
            const { ctx, loginService } = createCtx();
            const promise = quickLogin(ctx);
            // connect 注册的 listener 触发连接完成
            const listener = (loginService as { __listener?: Record<string, unknown> }).__listener;
            (listener?.["onLoginConnected"] as (() => void) | undefined)?.();
            await vi.advanceTimersByTimeAsync(3_100);
            await expect(promise).resolves.toEqual({ uin: "10001", uid: "u1", nick: "A" });
            expect(loginService.connect).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it("无 connect 方法（老版本 / QQ 自连）→ 跳过连接阶段直接拉列表", async () => {
        vi.useFakeTimers();
        try {
            const { ctx } = createCtx({
                connect: undefined,
                addKernelLoginListener: undefined,
            });
            const promise = quickLogin(ctx);
            await vi.advanceTimersByTimeAsync(0);
            await expect(promise).resolves.toEqual({ uin: "10001", uid: "u1", nick: "A" });
        } finally {
            vi.useRealTimers();
        }
    });

    it("connect 抛错 → 完成连接等待继续（finish 兜底）", async () => {
        vi.useFakeTimers();
        try {
            const { ctx, loginService } = createCtx({
                connect: vi.fn(() => {
                    throw new Error("connect crash");
                }),
            });
            const promise = quickLogin(ctx);
            await vi.advanceTimersByTimeAsync(3_100);
            await expect(promise).resolves.toEqual({ uin: "10001", uid: "u1", nick: "A" });
            expect(loginService.quickLoginWithUin).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it("监听注册抛错不阻塞连接（15s 兜底后继续）", async () => {
        vi.useFakeTimers();
        try {
            const { ctx } = createCtx({
                addKernelLoginListener: vi.fn(() => {
                    throw new Error("listener reg fail");
                }),
            });
            const promise = quickLogin(ctx);
            // 15s 连接兜底 + 3s 缓冲
            await vi.advanceTimersByTimeAsync(ConnectPhaseMs);
            await expect(promise).resolves.toEqual({ uin: "10001", uid: "u1", nick: "A" });
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("waitForNetworkConnection 补充", () => {
    it("就绪（getMsfStatus=3）→ true", async () => {
        vi.useFakeTimers();
        try {
            const { ctx } = createCtx();
            const promise = waitForNetworkConnection(ctx, { timeoutMs: 5000 });
            await vi.advanceTimersByTimeAsync(2_000);
            await expect(promise).resolves.toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it("持续未就绪 → 超时 false", async () => {
        vi.useFakeTimers();
        try {
            const { ctx } = createCtx({ getMsfStatus: vi.fn(() => 0) });
            const promise = waitForNetworkConnection(ctx, { timeoutMs: 2000 });
            await vi.advanceTimersByTimeAsync(3_000);
            await expect(promise).resolves.toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    it("getMsfStatus 抛错按未就绪处理（不炸轮询）", async () => {
        vi.useFakeTimers();
        try {
            const { ctx } = createCtx({
                getMsfStatus: vi.fn(() => {
                    throw new Error("msf boom");
                }),
            });
            const promise = waitForNetworkConnection(ctx, { timeoutMs: 1000 });
            await vi.advanceTimersByTimeAsync(2_000);
            await expect(promise).resolves.toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("纯函数补充", () => {
    it("pickLoginTarget：isQuickLogin 缺省项不参与优先选择", () => {
        const items: LoginAccountInfo[] = [{ uin: "1" }, { uin: "2", isQuickLogin: true }];
        expect(pickLoginTarget(items, undefined)).toEqual(items[1]);
    });

    it("isNetworkError：大小写敏感（1006511 精确子串）", () => {
        expect(isNetworkError("x1006511y")).toBe(true);
        expect(isNetworkError("登录系统连接异常！")).toBe(true);
        expect(isNetworkError("100651")).toBe(false);
    });
});

describe("超时与监听分支补充", () => {
    it("waitForNetworkConnection：不传 timeoutMs → 默认 15s 兜底", async () => {
        vi.useFakeTimers();
        try {
            const { ctx } = createCtx({ getMsfStatus: vi.fn(() => 0) });
            const promise = waitForNetworkConnection(ctx);
            const assertion = expect(promise).resolves.toBe(false);
            // waitFor 在 elapsed > timeoutMs 时才判超时（含 > 严格比较，16s 处收口）
            await vi.advanceTimersByTimeAsync(16_500);
            await assertion;
        } finally {
            vi.useRealTimers();
        }
    });

    it("无 addKernelLoginListener（有 connect）→ 不注册监听，15s 兜底后继续", async () => {
        vi.useFakeTimers();
        try {
            const { ctx, loginService } = createCtx({
                addKernelLoginListener: undefined,
            });
            const promise = quickLogin(ctx);
            const assertion = expect(promise).resolves.toEqual({
                uin: "10001",
                uid: "u1",
                nick: "A",
            });
            await vi.advanceTimersByTimeAsync(ConnectPhaseMs + 100);
            await assertion;
            expect(loginService.connect).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it("onLoginConnected 先触发后再到 15s 兜底 → finish 幂等（不二次 resolve）", async () => {
        vi.useFakeTimers();
        try {
            const { ctx, loginService } = createCtx();
            const promise = quickLogin(ctx);
            const assertion = expect(promise).resolves.toEqual({
                uin: "10001",
                uid: "u1",
                nick: "A",
            });
            const listener = (loginService as { __listener?: Record<string, unknown> }).__listener;
            (listener?.["onLoginConnected"] as (() => void) | undefined)?.();
            await vi.advanceTimersByTimeAsync(3_100);
            await assertion;
            // 兜底计时器后到：finish 已 settled → 直接返回（不 resolve 第二次）
            await vi.advanceTimersByTimeAsync(20_000);
            expect(loginService.getLoginList).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it("LocalLoginInfo 无 uid/nickName → 登录结果退化空串", async () => {
        vi.useFakeTimers();
        try {
            const { ctx } = createCtx({
                getLoginList: vi.fn(async () => ({
                    result: 0,
                    LocalLoginInfoList: [{ uin: "30003", isQuickLogin: true }],
                })),
            });
            const promise = quickLogin(ctx);
            const assertion = expect(promise).resolves.toEqual({
                uin: "30003",
                uid: "",
                nick: "",
            });
            await vi.advanceTimersByTimeAsync(ConnectPhaseMs);
            await assertion;
        } finally {
            vi.useRealTimers();
        }
    });
});
