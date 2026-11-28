import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WrapperContext } from "../../../src/native/wrapper/types.js";
import { type LoginAccountInfo, quickLogin } from "../../../src/runtime/login/quick-login.js";
import type { KernelLoginListener, NodeIKernelLoginService } from "../../../src/types/wrapper.js";

const CONNECTION_SETTLE_MS = 3_000;
const MSF_POLL_MS = 1_000;
const STEP_TIMEOUT_MS = 200;
const NETWORK_ERROR = "错误码: 1006511";
const targetAccount = { uin: "10002", uid: "uid-2", nickName: "second", isQuickLogin: true };
const accounts: LoginAccountInfo[] = [
    { uin: "10001", uid: "uid-1", nickName: "first", isQuickLogin: true },
    targetAccount,
];

interface NativeLoginResult {
    result: string;
    loginErrorInfo: { errMsg: string };
}

function createLoginFixture() {
    let connectListener: KernelLoginListener | undefined;
    const loginService = {
        addKernelLoginListener(listener: KernelLoginListener): number {
            connectListener = listener;
            return 1;
        },
        connect(): void {
            connectListener?.onLoginConnected?.();
        },
        removeKernelLoginListener(): void {
            connectListener = undefined;
        },
        getLoginList: vi.fn<NodeIKernelLoginService["getLoginList"]>().mockResolvedValue({
            result: 0,
            LocalLoginInfoList: accounts,
        }),
        quickLoginWithUin: vi.fn<(uin: string) => Promise<NativeLoginResult>>().mockResolvedValue({
            result: "0",
            loginErrorInfo: { errMsg: "" },
        }),
        getMsfStatus: vi.fn(() => 3),
    };
    const ctx: WrapperContext = {
        get exports(): never {
            throw new Error("quickLogin should not read wrapper exports");
        },
        get engine(): never {
            throw new Error("quickLogin should not read the wrapper engine");
        },
        versionInfo: { fullVersion: "", buildVersion: "" },
        session: null,
        startupSession: null,
        loginService,
    };
    return { ctx, loginService };
}

describe("quickLogin", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("显式账号不存在时返回 NOT_FOUND，未向 wrapper 提交其他账号", async () => {
        const { ctx, loginService } = createLoginFixture();

        await Promise.all([
            expect(quickLogin(ctx, { uin: "99999" })).rejects.toMatchObject({
                code: "NOT_FOUND",
                message: expect.stringContaining("99999"),
            }),
            vi.advanceTimersByTimeAsync(CONNECTION_SETTLE_MS),
        ]);
        expect(loginService.quickLoginWithUin).not.toHaveBeenCalled();
    });

    it("网络异常后等 MSF 就绪，再用指定账号登录并返回其身份", async () => {
        const { ctx, loginService } = createLoginFixture();
        loginService.getMsfStatus.mockReturnValue(0);
        loginService.quickLoginWithUin.mockResolvedValueOnce({
            result: "1006511",
            loginErrorInfo: { errMsg: NETWORK_ERROR },
        });
        const outcome = quickLogin(ctx, { uin: targetAccount.uin }).catch(
            (error: unknown) => error,
        );

        await vi.advanceTimersByTimeAsync(CONNECTION_SETTLE_MS + MSF_POLL_MS);
        expect(loginService.quickLoginWithUin.mock.calls).toEqual([[targetAccount.uin]]);

        loginService.getMsfStatus.mockReturnValue(3);
        await vi.advanceTimersByTimeAsync(MSF_POLL_MS);

        expect(await outcome).toEqual({
            uin: targetAccount.uin,
            uid: targetAccount.uid,
            nick: targetAccount.nickName,
        });
        expect(loginService.quickLoginWithUin.mock.calls).toEqual([
            [targetAccount.uin],
            [targetAccount.uin],
        ]);
    });

    it("网络持续报错时总共尝试三次并返回 NOT_LOGIN", async () => {
        const { ctx, loginService } = createLoginFixture();
        loginService.quickLoginWithUin.mockResolvedValue({
            result: "1006511",
            loginErrorInfo: { errMsg: NETWORK_ERROR },
        });

        await Promise.all([
            expect(quickLogin(ctx, { uin: targetAccount.uin })).rejects.toMatchObject({
                code: "NOT_LOGIN",
                message: expect.stringContaining(NETWORK_ERROR),
            }),
            vi.advanceTimersByTimeAsync(CONNECTION_SETTLE_MS + 2 * MSF_POLL_MS),
        ]);
        expect(loginService.quickLoginWithUin.mock.calls).toEqual([
            [targetAccount.uin],
            [targetAccount.uin],
            [targetAccount.uin],
        ]);
    });

    it.each([
        { method: "getLoginList", loginAttempts: 0 },
        { method: "quickLoginWithUin", loginAttempts: 1 },
    ] as const)("$method 挂起时按单步期限返回 NOT_LOGIN", async ({ method, loginAttempts }) => {
        const { ctx, loginService } = createLoginFixture();
        loginService[method].mockReturnValue(Promise.withResolvers<never>().promise);
        const settled = vi.fn();
        const observation = quickLogin(ctx, { quickLoginTimeoutMs: STEP_TIMEOUT_MS }).then(
            settled,
            settled,
        );

        await vi.advanceTimersByTimeAsync(CONNECTION_SETTLE_MS + STEP_TIMEOUT_MS - 1);
        expect(settled).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(settled).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
                code: "NOT_LOGIN",
                message: expect.stringContaining("快速登录超时"),
            }),
        );
        await observation;
        await vi.advanceTimersByTimeAsync(2 * MSF_POLL_MS);
        expect(loginService.getLoginList).toHaveBeenCalledTimes(1);
        expect(loginService.quickLoginWithUin).toHaveBeenCalledTimes(loginAttempts);
        expect(loginService.getMsfStatus).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });
});
