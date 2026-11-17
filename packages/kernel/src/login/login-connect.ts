/**
 * 登录连接与快速登录（从 lifecycle.ts 拆分，2026-08-08 FTA 优化）
 *
 * - waitForNetworkConnection：等 MSF 网络连接就绪（getMsfStatus() === 3）
 * - ensureLoginConnected：connect() → 等 onLoginConnected（自建宿主必需）
 * - quickLogin：历史账号快速登录（网络异常 1006511 等就绪后重试；
 *   T3 单步超时兜底——底层 promise 永久挂起时按登录失败抛出）
 */

import { kernelError, sleep, waitFor } from "../infra/index.js";
import { hasFunctionProp, hasStringProp, isRecord } from "../utils/type-guards.js";
import { createLoginListener } from "../wrapper/wrapper-adapters.js";
import type { WrapperContext } from "../wrapper/wrapper-loader.js";

/** 登录结果（QR 或快速登录）。 */
export interface LoginResult {
    uin: string;
    uid: string;
    nick: string;
}

/** 登录列表项（getLoginList 返回，说明书参考）。 */
export interface LoginAccountInfo {
    uin: string;
    uid?: string | undefined;
    nickName?: string | undefined;
    isQuickLogin?: boolean | undefined;
}

/** 登录服务形状（getLoginList / quickLoginWithUin / getMsfStatus，自研描述）。 */
type LoginServiceShape = {
    getLoginList(): Promise<{ result: number; LocalLoginInfoList: LoginAccountInfo[] }>;
    quickLoginWithUin(uin: string): Promise<{ result: string; loginErrorInfo: { errMsg: string } }>;
    getMsfStatus(): number;
};

/** 登录连接所需的最小方法面（connect / add / remove 监听均可缺省）。 */
type LoginConnectionShape = {
    connect?: () => void;
    addKernelLoginListener?: (listener: unknown) => number;
    removeKernelLoginListener?: (listenerId: number) => void;
};

/**
 * 登录服务形状判定：getLoginList / quickLoginWithUin / getMsfStatus 齐备才算可用。
 * 判空职责从「调用点各自做两级强转」收拢到这里。
 */
function isLoginServiceShape(val: unknown): val is LoginServiceShape {
    return (
        isRecord(val) &&
        hasFunctionProp(val, "getLoginList") &&
        hasFunctionProp(val, "quickLoginWithUin") &&
        hasFunctionProp(val, "getMsfStatus")
    );
}

/** 校验并收窄 loginService（失败抛 INVALID_STATE，ADR-009）。 */
function requireLoginService(raw: unknown): LoginServiceShape {
    if (!isLoginServiceShape(raw)) {
        throw kernelError(
            "loginService 无效（缺 getLoginList / quickLoginWithUin / getMsfStatus）",
            "INVALID_STATE",
        );
    }
    return raw;
}

/** 连接方法面判定（connect / add / remove 监听存在时必须是函数）。 */
function isLoginConnectionShape(val: unknown): val is LoginConnectionShape {
    if (!isRecord(val)) {
        return false;
    }
    const connect = val["connect"];
    const addListener = val["addKernelLoginListener"];
    const removeListener = val["removeKernelLoginListener"];
    return (
        (connect === undefined || typeof connect === "function") &&
        (addListener === undefined || typeof addListener === "function") &&
        (removeListener === undefined || typeof removeListener === "function")
    );
}

/** 登录列表项形状判定（uin 是唯一必填字段）。 */
function isLoginAccountInfo(val: unknown): val is LoginAccountInfo {
    return isRecord(val) && hasStringProp(val, "uin");
}

/** getLoginList 返回 → 登录列表（形状异常返回空数组，不抛裸 TypeError）。 */
function extractLoginAccounts(list: unknown): LoginAccountInfo[] {
    if (!isRecord(list)) {
        return [];
    }
    const items = list["LocalLoginInfoList"];
    return Array.isArray(items) ? items.filter(isLoginAccountInfo) : [];
}

/** quickLoginWithUin 返回 → errMsg（结构缺失按「未知登录错误」处理）。 */
export function extractLoginErrMsg(result: unknown): string {
    if (!isRecord(result)) {
        return "未知登录错误";
    }
    const info = result["loginErrorInfo"];
    if (isRecord(info) && typeof info["errMsg"] === "string") {
        return info["errMsg"];
    }
    return "未知登录错误";
}

/**
 * 网络状态（MSF）常量。
 * 3 = 已连接（NapCat waitForNetworkConnection 语义，自研描述）。
 */
const MSF_STATUS_CONNECTED = 3;

/** 快速登录网络异常错误码（1006511，P2-1 实测：登录前网络未就绪时报此错）。 */
const NETWORK_ERROR_CODE = "1006511";

/** 登录连接异常错误提示（自建宿主实测：connect 后未缓冲即 quickLogin 报此错）。 */
const CONNECTION_ERROR_HINT = "登录系统连接异常";

/** 网络重试最大次数（每次重试前等网络就绪）。 */
const NETWORK_RETRY_MAX = 3;

/** 网络就绪等待超时（毫秒）。 */
const NETWORK_READY_TIMEOUT_MS = 15_000;

/** 网络就绪轮询间隔（毫秒）。 */
const NETWORK_READY_POLL_MS = 1000;

/** 连接稳定缓冲（毫秒，p0-kernel-flow 实证值）。 */
const CONNECTION_SETTLE_MS = 3000;

/**
 * 快速登录单步超时（毫秒，T3：软重登挂起兜底）。
 * 服务端已有同账号会话时底层 quickLoginWithUin / getLoginList 永不 settle——
 * 裸 await 会让 core.login 的 catch/qrFallback、loader 的 control.release 全部
 * 永久等待。底层 promise 无法取消：超时后悬挂丢弃即可。
 */
export const QUICK_LOGIN_TIMEOUT_MS = 20_000;

/** 快速登录超时文案（按登录失败处理；不含网络错误特征，不触发 1006511 重试叠挂）。 */
export const QUICK_LOGIN_TIMEOUT_MESSAGE = "快速登录超时";

/**
 * 等待网络连接就绪（loginService.getMsfStatus() === 3）。
 * 参考 NapCat waitForNetworkConnection 思路（自研实现）：快速登录在 QQ 刚拉起、
 * 网络栈未初始化时报 1006511 网络异常——等待 MSF 连接后再重试。
 * @returns 是否在超时前就绪。
 */
export function waitForNetworkConnection(
    ctx: WrapperContext,
    opts: { timeoutMs?: number } = {},
): Promise<boolean> {
    const raw = ctx.loginService;
    if (!isRecord(raw) || !hasFunctionProp(raw, "getMsfStatus")) {
        return Promise.resolve(false);
    }
    return waitFor(
        () => {
            try {
                return raw["getMsfStatus"]() === MSF_STATUS_CONNECTED;
            } catch {
                return false;
            }
        },
        opts.timeoutMs ?? NETWORK_READY_TIMEOUT_MS,
        NETWORK_READY_POLL_MS,
    );
}

/** 列出历史登录账号（boot.cjs 启动横幅用，「可用快速登录 of QQ」）。 */
export async function listLoginAccounts(ctx: WrapperContext): Promise<LoginAccountInfo[]> {
    const loginService = requireLoginService(ctx.loginService);
    const list: unknown = await loginService.getLoginList();
    return extractLoginAccounts(list);
}

/**
 * 登录服务连接（自建宿主必需，HANDOVER-V6/V10 p0-kernel-flow 实证顺序）：
 * connect() → 等 onLoginConnected。不 connect 则快速登录报「登录系统连接异常」。
 *
 * 对齐 p0-kernel-flow：initConfig → getLoginList → connect + onLoginConnected →
 * quickLoginWithUin。QQ 环境（worker/主进程）下可能已连接——connect 幂等，
 * 监听器超时兜底，不影响原流程。
 */
async function ensureLoginConnected(
    ctx: WrapperContext,
    opts: { timeoutMs?: number },
): Promise<void> {
    const raw = ctx.loginService;
    if (!isLoginConnectionShape(raw) || typeof raw.connect !== "function") {
        return; // 无 connect（老版本 / QQ 主进程自连），跳过
    }
    await waitLoginConnected(raw, opts.timeoutMs);
    // onLoginConnected 后网络栈仍在初始化（p0-kernel-flow 实证：connect → onLoginConnected
    // → 3s 缓冲 → quickLoginWithUin 成功；无缓冲则「登录系统连接异常」）。
    await sleep(CONNECTION_SETTLE_MS);
}

/** 等 onLoginConnected（注册临时监听 + connect + 超时兜底）。 */
function waitLoginConnected(
    raw: LoginConnectionShape,
    timeoutMs?: number | undefined,
): Promise<void> {
    return new Promise<void>((resolve) => {
        let settled = false;
        let listenerId: number | null = null;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const finish = (): void => {
            if (settled) {
                return;
            }
            settled = true;
            if (timer !== null) {
                clearTimeout(timer);
                timer = null;
            }
            removeConnectListener(raw, listenerId);
            listenerId = null;
            resolve();
        };
        listenerId = tryRegisterConnectListener(raw, finish);
        timer = setTimeout(finish, timeoutMs ?? NETWORK_READY_TIMEOUT_MS);
        // 不阻塞进程自然退出
        timer.unref?.();
        try {
            raw.connect?.();
        } catch {
            finish();
        }
    });
}

/**
 * 注册临时登录连接监听（失败不阻塞连接）。返回 listenerId（不可注册时为 null）。
 * 连接确认或超时后由 finish 统一 remove——软重登/多实例下不会堆积原生监听器。
 */
function tryRegisterConnectListener(raw: LoginConnectionShape, finish: () => void): number | null {
    try {
        const listener = createLoginListener();
        listener.onLoginConnected = () => {
            finish();
        };
        if (typeof raw.addKernelLoginListener === "function") {
            return raw.addKernelLoginListener(listener);
        }
        return null;
    } catch {
        // 监听注册失败不阻塞连接
        return null;
    }
}

/** 移除临时登录连接监听（无 remove 方法 / 抛错时静默——监听器随后续登录覆盖）。 */
function removeConnectListener(
    raw: { removeKernelLoginListener?: (listenerId: number) => void },
    listenerId: number | null,
): void {
    if (listenerId === null || typeof raw.removeKernelLoginListener !== "function") {
        return;
    }
    try {
        raw.removeKernelLoginListener(listenerId);
    } catch {
        // 移除失败不阻塞登录（原生侧最多残留一个临时监听）
    }
}

/**
 * 目标账号选择（2026-08-07 修复：显式 uin 不在列表时**报错**而非静默 fallback——
 * 之前会退到第一个可快速登录账号，导致 `-q <uin>` 实际登成别的号）。
 * 导出供单测（login-connect.test.ts）。
 */
export function pickLoginTarget(
    items: LoginAccountInfo[],
    uin: string | undefined,
): LoginAccountInfo {
    if (uin !== undefined) {
        const target = items.find((i) => i.uin === uin);
        if (target === undefined) {
            const available = items.map((i) => i.uin).join("、");
            throw kernelError(`账号 ${uin} 不在登录列表（可用：${available}）`, "NOT_FOUND");
        }
        return target;
    }
    // 未指定 uin：优先第一个可快速登录账号，否则列表第一个
    const quick = items.find((i) => i.isQuickLogin);
    if (quick !== undefined) {
        return quick;
    }
    const [first] = items;
    if (first === undefined) {
        throw kernelError("无可用登录账号", "NOT_LOGIN");
    }
    return first;
}

/** 单次快速登录尝试的结果（成功带结果，失败带错误消息）。 */
type AttemptResult = { ok: true; result: LoginResult } | { ok: false; errMsg: string };

/**
 * 底层 NAPI promise 超时竞速（T3）：promise 先 settle 用其结果，超时先到用
 * onTimeout 产物（可抛错 → 整体 reject）。底层 promise 无法取消，超时后
 * 悬挂丢弃——勿做清理动作引发二次问题；败者的迟到 settle 由 race 吞掉。
 */
function raceWithTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    onTimeout: () => T,
): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<T>((resolve, reject) => {
        timer = setTimeout(() => {
            try {
                resolve(onTimeout());
            } catch (err) {
                reject(err);
            }
        }, timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => {
        if (timer !== null) {
            clearTimeout(timer);
        }
    });
}

/**
 * 带网络重试的快速登录（P2-1）。
 * 重试语义：仅当失败为网络异常（1006511）且未达上限时，等网络就绪后重试。
 * T3：每次尝试包超时竞速，挂起按登录失败处理（超时文案非网络错误 → 不重试）。
 */
async function loginWithNetworkRetry(
    ctx: WrapperContext,
    loginService: LoginServiceShape,
    target: LoginAccountInfo,
    opts: { uin?: string | undefined; timeoutMs?: number | undefined },
    quickTimeoutMs: number,
): Promise<LoginResult> {
    let lastErrMsg = "";
    for (let attempt = 1; attempt <= NETWORK_RETRY_MAX; attempt += 1) {
        const attemptResult = await raceWithTimeout(
            attemptQuickLogin(loginService, target),
            quickTimeoutMs,
            (): AttemptResult => ({ ok: false, errMsg: QUICK_LOGIN_TIMEOUT_MESSAGE }),
        );
        if (attemptResult.ok) {
            return attemptResult.result;
        }
        lastErrMsg = attemptResult.errMsg;
        const shouldRetry = isNetworkError(lastErrMsg) && attempt < NETWORK_RETRY_MAX;
        if (!shouldRetry) {
            break;
        }
        const ready = await waitForNetworkConnection(ctx, {
            timeoutMs: opts.timeoutMs ?? NETWORK_READY_TIMEOUT_MS,
        });
        if (!ready) {
            break;
        }
    }
    throw kernelError(`快速登录失败: ${lastErrMsg}`, "NOT_LOGIN");
}

/** 单次快速登录尝试（成功带结果，失败带错误消息）。 */
async function attemptQuickLogin(
    loginService: LoginServiceShape,
    target: LoginAccountInfo,
): Promise<AttemptResult> {
    const result: unknown = await loginService.quickLoginWithUin(target.uin);
    const errMsg = extractLoginErrMsg(result);
    if (errMsg) {
        return { ok: false, errMsg };
    }
    return {
        ok: true,
        result: {
            uin: target.uin,
            uid: target.uid ?? "",
            nick: target.nickName ?? "",
        },
    };
}

/** 判定快速登录失败是否为网络异常（重试语义）。导出供单测。 */
export function isNetworkError(errMsg: string): boolean {
    return errMsg.includes(NETWORK_ERROR_CODE) || errMsg.includes(CONNECTION_ERROR_HINT);
}

/** quickLogin 参数（uin 指定账号；timeoutMs 网络就绪等待；quickLoginTimeoutMs 单步超时）。 */
export interface QuickLoginOptions {
    /** 指定快速登录账号（缺省遍历历史列表，优先 isQuickLogin）。 */
    uin?: string | undefined;
    /** 网络就绪等待超时（毫秒，P2-1 既有语义），默认 15s。 */
    timeoutMs?: number | undefined;
    /** 单步快速登录超时（毫秒，T3 挂起兜底），默认 {@link QUICK_LOGIN_TIMEOUT_MS}。 */
    quickLoginTimeoutMs?: number | undefined;
}

/**
 * 快速登录：遍历历史登录列表尝试。
 * P2-1：失败且错误为网络异常（1006511）时，等网络就绪后重试（最多 NETWORK_RETRY_MAX 次）。
 * T3：getLoginList 与每次 quickLoginWithUin 均包超时竞速（默认 20s）——服务端
 * 已有会话时底层 promise 永久挂起，超时按登录失败（「快速登录失败: 快速登录超时」）
 * 抛出，上层 catch/qrFallback 语义自动生效。
 */
export async function quickLogin(
    ctx: WrapperContext,
    opts: QuickLoginOptions = {},
): Promise<LoginResult> {
    const loginService = requireLoginService(ctx.loginService);
    const quickTimeoutMs = opts.quickLoginTimeoutMs ?? QUICK_LOGIN_TIMEOUT_MS;
    // 连接登录服务（自建宿主必需：不 connect 则「登录系统连接异常」）
    await ensureLoginConnected(ctx, {
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
    const list: unknown = await raceWithTimeout(loginService.getLoginList(), quickTimeoutMs, () => {
        throw kernelError(`快速登录失败: ${QUICK_LOGIN_TIMEOUT_MESSAGE}`, "NOT_LOGIN");
    });
    const items = extractLoginAccounts(list);
    if (items.length === 0) {
        throw kernelError("无历史登录账号", "NOT_LOGIN");
    }
    const target = pickLoginTarget(items, opts.uin);
    return loginWithNetworkRetry(ctx, loginService, target, opts, quickTimeoutMs);
}
