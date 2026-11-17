/**
 * login.ts：QR 登录流程编排 + 状态机 + selfInfo（ADR-010，2026-08-05）
 *
 * 流程（QQ wrapper 登录契约，自研实现）：
 *  loginService.initConfig（core.login 已做）→ addKernelLoginListener → connect()
 *  → 指定账号：quickLoginWithUin；否则 getQRCodePicture() 触发二维码
 *  → 回调驱动状态机：未登录 → 扫码中 → 已扫码 → 已登录（onQRCodeLoginSucceed）
 *  → 二维码过期（errType=1 errCode=3）→ refresh()
 *
 * 不含 UI 渲染（cli 只做二维码渲染/URL 打印）。
 */
import { kernelError } from "../infra/index.js";
import type { KernelLoginListener } from "../types/index.js";
import { hasMethodSurface } from "../utils/type-guards.js";
import { createLoginListener } from "../wrapper/wrapper-adapters.js";
import { extractLoginErrMsg } from "./login-connect.js";

/** 登录状态。 */
export type LoginState = "idle" | "waiting_scan" | "scanned" | "logged_in" | "failed";

/** 二维码数据（png base64 + 解码 url）。 */
export interface QrCodeData {
    pngBase64: string;
    qrcodeUrl: string;
}

/** selfInfo（登录成功后填写）。 */
export interface SelfInfo {
    uin: string;
    uid: string;
    nick: string;
}

/** 快速登录项。 */
export interface LoginListItem {
    uin: string;
    uid?: string;
    nickName?: string;
    isQuickLogin?: boolean;
}

/** loginService 接口（从 WrapperContext.loginService 获取）。 */
interface LoginServiceLike {
    addKernelLoginListener(listener: unknown): number;
    removeKernelLoginListener(listenerId: number): void;
    connect(): void;
    getLoginList(): Promise<{ result: number; LocalLoginInfoList: LoginListItem[] }>;
    quickLoginWithUin(uin: string): Promise<unknown>;
    getQRCodePicture(): boolean;
}

/** 运行时判定 loginService 是否具备 QrLoginSession 依赖的方法面。 */
function isLoginServiceLike(val: unknown): val is LoginServiceLike {
    return hasMethodSurface(val, [
        "addKernelLoginListener",
        "removeKernelLoginListener",
        "connect",
        "getLoginList",
        "quickLoginWithUin",
        "getQRCodePicture",
    ]);
}

/** 二维码过期错误码（errType=1 errCode=3，实测）。 */
const QR_EXPIRED_ERR_TYPE = 1;
const QR_EXPIRED_ERR_CODE = 3;

/** 登录超时上限（毫秒，参考项目 60 次 × 2s = 120s，2026-08-13 用户拍板照搬）。 */
export const QR_LOGIN_TIMEOUT_MS = 120_000;

/** 登录超时提示（参考项目文案，前端 failed 态展示）。 */
export const QR_LOGIN_TIMEOUT_MESSAGE = "登录超时，请刷新页面重试";

/** 二维码过期判定。 */
function isQrCodeExpired(errType: number, errCode: number): boolean {
    return errType === QR_EXPIRED_ERR_TYPE && errCode === QR_EXPIRED_ERR_CODE;
}

/** 二维码 png data URI 前缀剥离正则。 */
const DATA_URI_PREFIX_RE = /^data:image\/\w+;base64,/;

/** QR 登录会话（状态机 + 回调订阅）。 */
export class QrLoginSession {
    private readonly loginService: LoginServiceLike;
    private state: LoginState = "idle";
    private listenerId: number | null = null;
    private self: SelfInfo | null = null;
    private readonly qrCodeHandlers = new Set<(qr: QrCodeData) => void>();
    private readonly stateHandlers = new Set<(state: LoginState) => void>();
    /** 超时定时器（refresh 后启动，登录成功/失败/stop 清理）。 */
    private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    /** 失败原因（超时等，failed 态透出给上层提示文案）。 */
    private failureReasonValue: string | null = null;
    /** 超时上限（毫秒，默认 QR_LOGIN_TIMEOUT_MS）。 */
    private readonly timeoutMs: number;

    constructor(loginService: unknown, options: { timeoutMs?: number } = {}) {
        if (!isLoginServiceLike(loginService)) {
            throw kernelError("loginService 无效（缺 addKernelLoginListener）", "INVALID_STATE");
        }
        this.loginService = loginService;
        this.timeoutMs = options.timeoutMs ?? QR_LOGIN_TIMEOUT_MS;
    }

    /** 当前状态。 */
    get currentState(): LoginState {
        return this.state;
    }

    /** selfInfo（登录成功后有值）。 */
    get selfInfo(): SelfInfo | null {
        return this.self;
    }

    /** 失败原因（超时等；failed 态透出给上层提示文案）。 */
    get failureReason(): string | null {
        return this.failureReasonValue;
    }

    /** 订阅二维码（png base64 + url）。返回退订函数。 */
    onQrCode(cb: (qr: QrCodeData) => void): () => void {
        this.qrCodeHandlers.add(cb);
        return () => this.qrCodeHandlers.delete(cb);
    }

    /** 订阅状态变化。返回退订函数。 */
    onStateChange(cb: (state: LoginState) => void): () => void {
        this.stateHandlers.add(cb);
        return () => this.stateHandlers.delete(cb);
    }

    /** 开始登录：注册监听 → connect → 快速登录（指定账号）或触发二维码。 */
    start(opts: { quickUin?: string } = {}): void {
        if (this.state !== "idle") {
            return;
        }
        this.listenerId = this.loginService.addKernelLoginListener(this.buildListener());
        this.loginService.connect();
        if (opts.quickUin !== undefined && opts.quickUin !== "") {
            // T3：快速登录可能永久挂起（服务端已有同账号会话）——先启动超时计时，
            // 挂起 → 超时 failed。此前挂起时连兜底计时都不启动（定时器只在 refresh
            // 里重启），ready 态软重登完全无兜底。
            this.restartTimeout();
            this.loginService
                .quickLoginWithUin(opts.quickUin)
                .then((result) => {
                    // ⚠️ wrapper 契约（attemptQuickLogin 已实证）：快速登录失败是
                    // resolve 带 loginErrorInfo.errMsg，**不是 reject**——只挂 .catch
                    // 会永不触发 → 无凭据环境（WSL 扫码）永不 refresh → 二维码永不
                    // 产生，完全静默阻塞（2026-08-13 WSL 扫码卡死根因）。
                    if (extractLoginErrMsg(result) !== "") {
                        this.refreshAfterQuickLogin();
                    }
                })
                .catch(() => {
                    // reject（异常路径）同样回退二维码
                    this.refreshAfterQuickLogin();
                });
        } else {
            this.refresh();
        }
    }

    /**
     * 快速登录失败回退二维码。仅 idle 态生效：超时 failed 后悬挂 promise 的
     * 迟到结果（含登录成功后 stop 之后的迟到 settle）不得复活会话/重复出码。
     */
    private refreshAfterQuickLogin(): void {
        if (this.state === "idle") {
            this.refresh();
        }
    }

    /** 刷新二维码（手动 / 过期自动）。每次出码重启超时计时。 */
    refresh(): void {
        this.failureReasonValue = null;
        this.setState("waiting_scan");
        this.loginService.getQRCodePicture();
        this.restartTimeout();
    }

    /** 构建登录监听（普通 JS 对象，NAPI 反射）。 */
    private buildListener(): KernelLoginListener {
        const listener = createLoginListener();
        listener.onQRCodeGetPicture = ({ pngBase64QrcodeData, qrcodeUrl }) => {
            const realBase64 = pngBase64QrcodeData.replace(DATA_URI_PREFIX_RE, "");
            this.emitQrCode({ pngBase64: realBase64, qrcodeUrl });
        };
        listener.onQRCodeLoginPollingStarted = () => {
            this.setState("waiting_scan");
        };
        listener.onQRCodeSessionUserScaned = () => {
            this.setState("scanned");
        };
        listener.onQRCodeLoginSucceed = (result) => {
            this.clearTimeoutTimer();
            this.self = { uin: result.uin, uid: result.uid, nick: result.nick ?? "" };
            this.setState("logged_in");
        };
        listener.onQRCodeSessionFailed = (errType, errCode) => {
            if (isQrCodeExpired(errType, errCode)) {
                // 二维码过期 → 自动刷新（2026-08-13 用户拍板保留自动刷新 + 手动刷新按钮）
                this.refresh();
                return;
            }
            this.clearTimeoutTimer();
            this.failureReasonValue = null;
            this.setState("failed");
        };
        listener.onLoginFailed = () => {
            this.clearTimeoutTimer();
            this.failureReasonValue = null;
            this.setState("failed");
        };
        return listener;
    }

    /** 停止：注销监听（登录成功后调用，防重复回调）。 */
    stop(): void {
        this.clearTimeoutTimer();
        if (this.listenerId !== null) {
            this.loginService.removeKernelLoginListener(this.listenerId);
            this.listenerId = null;
        }
    }

    /** 重启超时计时器：超时未登录 → failed + 超时提示。 */
    private restartTimeout(): void {
        this.clearTimeoutTimer();
        this.timeoutTimer = setTimeout(() => {
            this.timeoutTimer = null;
            this.failureReasonValue = QR_LOGIN_TIMEOUT_MESSAGE;
            this.setState("failed");
        }, this.timeoutMs);
    }

    /** 清理超时计时器（幂等）。 */
    private clearTimeoutTimer(): void {
        if (this.timeoutTimer !== null) {
            clearTimeout(this.timeoutTimer);
            this.timeoutTimer = null;
        }
    }

    private setState(next: LoginState): void {
        this.state = next;
        for (const cb of this.stateHandlers) {
            cb(next);
        }
    }

    private emitQrCode(qr: QrCodeData): void {
        for (const cb of this.qrCodeHandlers) {
            cb(qr);
        }
    }
}
