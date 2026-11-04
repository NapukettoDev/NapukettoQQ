// biome-ignore-all lint/style/useNamingConvention: 对象键名为 QQ wrapper.node 真实导出名（PascalCase），必须原样保留
/**
 * login.ts QrLoginSession 扩展测试（login.test.ts 基线之外的回调面与订阅面）：
 *  - constructor 校验（null / 缺 addKernelLoginListener）
 *  - onQrCode / onStateChange 订阅与退订；多订阅者广播
 *  - listener 回调链：onQRCodeGetPicture（data URI 剥离）/ onQRCodeLoginPollingStarted /
 *    onQRCodeSessionUserScaned / onQRCodeLoginSucceed（selfInfo）/ onQRCodeSessionFailed
 *    （过期自动刷新 / 其他失败）/ onLoginFailed
 *  - start 非 idle 幂等 / stop 注销监听
 */
import { describe, expect, it, vi } from "vitest";
import type { IKernelLoginListener } from "../../types/index.js";
import { QrLoginSession } from "../login.js";

/** 构造假 loginService（捕获 listener）。 */
function createFakeLoginService(overrides: Partial<Record<string, unknown>> = {}) {
    let captured: IKernelLoginListener | undefined;
    const svc = {
        addKernelLoginListener: vi.fn((listener: unknown) => {
            captured = listener as IKernelLoginListener;
            return 1;
        }),
        removeKernelLoginListener: vi.fn(),
        connect: vi.fn(),
        getLoginList: vi.fn(async () => ({ result: 0, LocalLoginInfoList: [] })),
        quickLoginWithUin: vi.fn(async () => ({
            result: "0",
            loginErrorInfo: { errMsg: "" },
        })),
        getQRCodePicture: vi.fn(() => true),
        ...overrides,
    };
    return { svc, listener: () => captured };
}

function makeSession(svc: unknown, opts: { timeoutMs?: number } = {}): QrLoginSession {
    return new QrLoginSession(svc, opts);
}

describe("constructor", () => {
    it("loginService 为 null 抛 INVALID_STATE", () => {
        expect(() => new QrLoginSession(null)).toThrow(/loginService 无效/);
    });

    it("缺 addKernelLoginListener 抛 INVALID_STATE", () => {
        expect(() => new QrLoginSession({ connect: vi.fn() })).toThrow(/loginService 无效/);
    });

    it("自定义 timeoutMs 生效（快速超时验证）", () => {
        vi.useFakeTimers();
        try {
            const { svc } = createFakeLoginService();
            const session = makeSession(svc, { timeoutMs: 1000 });
            let state: string | null = null;
            session.onStateChange((s) => (state = s));
            session.start();
            vi.advanceTimersByTime(1000);
            expect(state).toBe("failed");
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("订阅退订", () => {
    it("onQrCode 返回退订函数（退订后不再收到）", () => {
        const { svc, listener } = createFakeLoginService();
        const session = makeSession(svc);
        const cb = vi.fn();
        const off = session.onQrCode(cb);
        session.start();
        listener()?.onQRCodeGetPicture?.({
            pngBase64QrcodeData: "data:image/png;base64,QUJD",
            qrcodeUrl: "https://qq/qr",
        } as never);
        expect(cb).toHaveBeenCalledWith({ pngBase64: "QUJD", qrcodeUrl: "https://qq/qr" });
        off();
        listener()?.onQRCodeGetPicture?.({
            pngBase64QrcodeData: "data:image/png;base64,RFVG",
            qrcodeUrl: "https://qq/qr2",
        } as never);
        expect(cb).toHaveBeenCalledTimes(1);
    });

    it("onStateChange 返回退订函数", () => {
        const { svc } = createFakeLoginService();
        const session = makeSession(svc);
        const cb = vi.fn();
        const off = session.onStateChange(cb);
        session.start();
        expect(cb).toHaveBeenCalledWith("waiting_scan");
        off();
        session.refresh();
        expect(cb).toHaveBeenCalledTimes(1);
    });

    it("多订阅者广播（qr + state）", () => {
        const { svc, listener } = createFakeLoginService();
        const session = makeSession(svc);
        const qrA = vi.fn();
        const qrB = vi.fn();
        session.onQrCode(qrA);
        session.onQrCode(qrB);
        session.start();
        listener()?.onQRCodeGetPicture?.({
            pngBase64QrcodeData: "RAW",
            qrcodeUrl: "u",
        } as never);
        expect(qrA).toHaveBeenCalledTimes(1);
        expect(qrB).toHaveBeenCalledTimes(1);
    });
});

describe("listener 回调链", () => {
    it("onQRCodeGetPicture：data URI 前缀剥离 / 无前缀原样", () => {
        const { svc, listener } = createFakeLoginService();
        const session = makeSession(svc);
        const cb = vi.fn();
        session.onQrCode(cb);
        session.start();
        listener()?.onQRCodeGetPicture?.({
            pngBase64QrcodeData: "data:image/jpeg;base64,WFk=",
            qrcodeUrl: "u1",
        } as never);
        expect(cb).toHaveBeenLastCalledWith({ pngBase64: "WFk=", qrcodeUrl: "u1" });
        listener()?.onQRCodeGetPicture?.({
            pngBase64QrcodeData: "plainbase64",
            qrcodeUrl: "u2",
        } as never);
        expect(cb).toHaveBeenLastCalledWith({ pngBase64: "plainbase64", qrcodeUrl: "u2" });
    });

    it("onQRCodeLoginPollingStarted → waiting_scan；onQRCodeSessionUserScaned → scanned", () => {
        const { svc, listener } = createFakeLoginService();
        const session = makeSession(svc);
        const states: string[] = [];
        session.onStateChange((s) => states.push(s));
        session.start();
        listener()?.onQRCodeLoginPollingStarted?.();
        listener()?.onQRCodeSessionUserScaned?.();
        expect(states).toEqual(["waiting_scan", "waiting_scan", "scanned"]);
    });

    it("onQRCodeLoginSucceed → logged_in + selfInfo 填充；超时计时清理", () => {
        vi.useFakeTimers();
        try {
            const { svc, listener } = createFakeLoginService();
            const session = makeSession(svc);
            let state: string | null = null;
            session.onStateChange((s) => (state = s));
            session.start();
            listener()?.onQRCodeLoginSucceed?.({ uin: "10001", uid: "u1", nick: "甲" } as never);
            expect(state).toBe("logged_in");
            expect(session.selfInfo).toEqual({ uin: "10001", uid: "u1", nick: "甲" });
            // 登录成功后超时不再触发
            vi.advanceTimersByTime(300_000);
            expect(state).toBe("logged_in");
        } finally {
            vi.useRealTimers();
        }
    });

    it("onQRCodeLoginSucceed：nick 缺省回退空串", () => {
        const { svc, listener } = createFakeLoginService();
        const session = makeSession(svc);
        session.start();
        listener()?.onQRCodeLoginSucceed?.({ uin: "1", uid: "u" } as never);
        expect(session.selfInfo?.nick).toBe("");
    });

    it("onQRCodeSessionFailed：errType=1 errCode=3 过期 → 自动 refresh 重新出码", () => {
        const { svc, listener } = createFakeLoginService();
        const session = makeSession(svc);
        const states: string[] = [];
        session.onStateChange((s) => states.push(s));
        session.start();
        listener()?.onQRCodeSessionFailed?.(1, 3, "");
        expect(svc.getQRCodePicture).toHaveBeenCalledTimes(2);
        expect(states.at(-1)).toBe("waiting_scan");
    });

    it("onQRCodeSessionFailed：其他错误 → failed（不刷新）", () => {
        const { svc, listener } = createFakeLoginService();
        const session = makeSession(svc);
        session.start();
        listener()?.onQRCodeSessionFailed?.(2, 500, "");
        expect(svc.getQRCodePicture).toHaveBeenCalledTimes(1);
        expect(session.currentState).toBe("failed");
        expect(session.failureReason).toBeNull();
    });

    it("errType=1 但 errCode≠3（半匹配）不算过期", () => {
        const { svc, listener } = createFakeLoginService();
        const session = makeSession(svc);
        session.start();
        listener()?.onQRCodeSessionFailed?.(1, 9, "");
        expect(session.currentState).toBe("failed");
    });

    it("onLoginFailed → failed", () => {
        const { svc, listener } = createFakeLoginService();
        const session = makeSession(svc);
        session.start();
        listener()?.onLoginFailed?.({});
        expect(session.currentState).toBe("failed");
    });
});

describe("start/stop 幂等", () => {
    it("非 idle 重复 start 不重复注册监听", () => {
        const { svc } = createFakeLoginService();
        const session = makeSession(svc);
        session.start();
        session.start();
        expect(svc.addKernelLoginListener).toHaveBeenCalledTimes(1);
    });

    it("stop 注销监听且幂等；stop 后 state 不回 idle（重复 start 仍被守卫拦截）", () => {
        const { svc } = createFakeLoginService();
        const session = makeSession(svc);
        session.start();
        session.stop();
        session.stop();
        expect(svc.removeKernelLoginListener).toHaveBeenCalledTimes(1);
        expect(svc.removeKernelLoginListener).toHaveBeenCalledWith(1);
        // stop 不重置状态机：waiting_scan 态下 start 被 idle 守卫拦截，不重新注册
        session.start();
        expect(svc.addKernelLoginListener).toHaveBeenCalledTimes(1);
    });

    it("未 start 直接 stop 不产生注销调用", () => {
        const { svc } = createFakeLoginService();
        const session = makeSession(svc);
        session.stop();
        expect(svc.removeKernelLoginListener).not.toHaveBeenCalled();
    });

    it("start 带 connect 调用；quickUin 空串视为未指定（走 QR）", () => {
        const { svc } = createFakeLoginService();
        const session = makeSession(svc);
        session.start({ quickUin: "" });
        expect(svc.connect).toHaveBeenCalledTimes(1);
        expect(svc.quickLoginWithUin).not.toHaveBeenCalled();
        expect(svc.getQRCodePicture).toHaveBeenCalledTimes(1);
    });
});
