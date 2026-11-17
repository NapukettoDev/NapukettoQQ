/**
 * type-guards / wrapper-guards 边界测试（二阶段 Step 5 门禁）
 *
 * 覆盖：原生反射守卫对 null / 原始值 / 数组 / 残缺 C++ 包装对象的拒绝能力，
 * 以及 QrLoginSession 在 quickLogin 返回无 loginErrorInfo 的 `{ result: -1 }`
 * 时安全提取错误、回退二维码（不抛 TypeError）。
 */
import { describe, expect, it, vi } from "vitest";
import { QrLoginSession } from "../login/login.js";
import { extractLoginErrMsg } from "../login/login-connect.js";
import { hasCallableProp, hasMethodSurface, isRecord } from "../utils/type-guards.js";
import {
    isStartupSessionWrapper,
    isWrapperEngine,
    isWrapperNodeApi,
    isWrapperSession,
} from "../wrapper/wrapper-guards.js";

describe("基础守卫拒绝非法形状", () => {
    it("isRecord：仅接受普通对象", () => {
        expect(isRecord({})).toBe(true);
        expect(isRecord({ a: 1 })).toBe(true);
        for (const bad of [null, undefined, 42, "x", true, [], [1], () => undefined]) {
            expect(isRecord(bad)).toBe(false);
        }
    });

    it("hasCallableProp：null / 原始值 / 数组 / 非函数属性一律拒绝", () => {
        expect(hasCallableProp({ run: () => undefined }, "run")).toBe(true);
        expect(hasCallableProp({ run: 1 }, "run")).toBe(false);
        expect(hasCallableProp({}, "run")).toBe(false);
        for (const bad of [null, undefined, 42, "x", [], [() => undefined]]) {
            expect(hasCallableProp(bad, "run")).toBe(false);
        }
    });

    it("hasMethodSurface：缺任一方法即拒绝", () => {
        const full = {
            init: () => undefined,
            getMsgService: () => null,
            startNT: () => undefined,
        };
        expect(hasMethodSurface(full, ["init", "getMsgService"])).toBe(true);
        expect(hasMethodSurface({ init: () => undefined }, ["init", "getMsgService"])).toBe(false);
        expect(hasMethodSurface({ init: 1, getMsgService: () => null }, ["init"])).toBe(false);
        for (const bad of [null, undefined, 7, "x", []]) {
            expect(hasMethodSurface(bad, ["init"])).toBe(false);
        }
    });
});

describe("wrapper 原生守卫拒绝残缺包装对象", () => {
    it("isWrapperSession：仅 getMsgService 可调用才算可用 session", () => {
        expect(isWrapperSession({ getMsgService: () => null })).toBe(true);
        for (const bad of [
            null,
            undefined,
            42,
            "session",
            [],
            {},
            { getMsgService: null },
            { getMsgService: 1 },
        ]) {
            expect(isWrapperSession(bad)).toBe(false);
        }
    });

    it("isWrapperEngine：缺 initWithDeskTopConfig 的残缺引擎拒绝", () => {
        expect(isWrapperEngine({ initWithDeskTopConfig: () => undefined })).toBe(true);
        for (const bad of [null, 0, "engine", [], {}, { readyToShow: () => undefined }]) {
            expect(isWrapperEngine(bad)).toBe(false);
        }
    });

    it("isStartupSessionWrapper：缺 start 的残缺包装拒绝", () => {
        expect(isStartupSessionWrapper({ start: () => undefined })).toBe(true);
        for (const bad of [null, false, 1, [], {}, { getSessionIdList: () => new Map() }]) {
            expect(isStartupSessionWrapper(bad)).toBe(false);
        }
    });

    it("isWrapperNodeApi：无任何 QQNT 导出符号的对象 / 非对象拒绝", () => {
        const api: Record<string, unknown> = {};
        api["NodeIKernelLoginService"] = {};
        expect(isWrapperNodeApi(api)).toBe(true);
        for (const bad of [null, undefined, 42, "wrapper", [], {}, { other: 1 }]) {
            expect(isWrapperNodeApi(bad)).toBe(false);
        }
    });
});

describe("QrLoginSession 快速登录错误提取", () => {
    /** 构造带完整方法面的假 loginService。 */
    function makeService(quickResult: unknown) {
        return {
            addKernelLoginListener: vi.fn(() => 1),
            removeKernelLoginListener: vi.fn(),
            connect: vi.fn(),
            getLoginList: vi.fn(async () => ({ result: 0, items: [] })),
            quickLoginWithUin: vi.fn(async () => quickResult),
            getQRCodePicture: vi.fn(() => false),
        };
    }

    it("缺少 loginErrorInfo 的 { result: -1 } → 安全提取「未知登录错误」并回退二维码", async () => {
        vi.useFakeTimers();
        try {
            expect(extractLoginErrMsg({ result: -1 })).toBe("未知登录错误");
            const service = makeService({ result: -1 });
            const session = new QrLoginSession(service, { timeoutMs: 1000 });
            session.start({ quickUin: "10001" });
            await vi.advanceTimersByTimeAsync(0);
            expect(service.quickLoginWithUin).toHaveBeenCalledWith("10001");
            expect(service.getQRCodePicture).toHaveBeenCalledTimes(1);
            expect(session.currentState).toBe("waiting_scan");
            session.stop();
        } finally {
            vi.useRealTimers();
        }
    });

    it("空 errMsg → 不误判失败（不触发二维码刷新）", async () => {
        vi.useFakeTimers();
        try {
            expect(extractLoginErrMsg({ result: "0", loginErrorInfo: { errMsg: "" } })).toBe("");
            const service = makeService({ result: "0", loginErrorInfo: { errMsg: "" } });
            const session = new QrLoginSession(service, { timeoutMs: 1000 });
            session.start({ quickUin: "10001" });
            await vi.advanceTimersByTimeAsync(0);
            expect(service.getQRCodePicture).not.toHaveBeenCalled();
            session.stop();
        } finally {
            vi.useRealTimers();
        }
    });
});
