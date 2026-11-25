/**
 * MSF 网络连接与 loginService 连接等待：waitForNetworkConnection 等 getMsfStatus() === 3，
 * ensureLoginConnected 走 connect() → 等 onLoginConnected（自建宿主必需）。快速登录/重试在
 * `quick-login.ts`（本文件不反向依赖）。
 */
import { hasFunctionProp, isRecord, sleep, waitFor } from "../../infra/index.js";
import type { WrapperContext } from "../../native/wrapper/lifecycle.js";
import { createLoginListener } from "../../native/wrapper/wrapper-adapters.js";

/**
 * 网络状态（MSF）常量。
 * 3 = 已连接（NapCat waitForNetworkConnection 语义，自研描述）。
 */
const MSF_STATUS_CONNECTED = 3;

/** 网络就绪等待超时（毫秒）。 */
export const NETWORK_READY_TIMEOUT_MS = 15_000;

/** 网络就绪轮询间隔（毫秒）。 */
const NETWORK_READY_POLL_MS = 1000;

/** 连接稳定缓冲（毫秒，实测值）。 */
const CONNECTION_SETTLE_MS = 3000;

/** 登录连接所需的最小方法面（connect / add / remove 监听均可缺省）。 */
type LoginConnectionShape = {
    connect?: () => void;
    addKernelLoginListener?: (listener: unknown) => number;
    removeKernelLoginListener?: (listenerId: number) => void;
};

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

/**
 * 登录服务连接（自建宿主必需，实测顺序）：connect() → 等 onLoginConnected。
 * 不 connect 则快速登录报「登录系统连接异常」。
 *
 * 顺序：initConfig → getLoginList → connect + onLoginConnected → quickLoginWithUin。
 * QQ 环境（worker/主进程）下可能已连接——connect 幂等，监听器超时兜底，不影响原流程。
 */
export async function ensureLoginConnected(
    ctx: WrapperContext,
    opts: { timeoutMs?: number },
): Promise<void> {
    const raw = ctx.loginService;
    if (!isLoginConnectionShape(raw) || typeof raw.connect !== "function") {
        return; // 无 connect（老版本 / QQ 主进程自连），跳过
    }
    await waitLoginConnected(raw, opts.timeoutMs);
    // onLoginConnected 后网络栈仍在初始化（实测：connect → onLoginConnected → 3s 缓冲
    // → quickLoginWithUin 成功；无缓冲则「登录系统连接异常」）。
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
