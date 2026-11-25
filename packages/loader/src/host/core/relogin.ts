/**
 * relogin.ts：登录控制相位机 + control login 指令处理（2026-09-08 A1/A2）。
 *
 * control login（koishi 面板「重新登录/扫码登录」→ IPC control login 指令）
 * 的成功结果按引导相位分派三条路径：
 *  ① login-race（初始登录竞速中）：结果经 preemptRef 接管引导链——快速登录
 *     风控挂起时强制扫码也能走完装配链（2026-09-08 T2 既有语义）。
 *  ② ready（引导已完成）：**软重登**——重装配（清理旧服务 + 用新结果重跑
 *     装配链），不再整进程重启；完成后重播 ready + logged_in。
 *  ③ assembling/aborted：迟到结果**不上报**（A1 修复）——引导失败进程将退出，
 *     无条件 sendLogin("logged_in") 会制造 failed→logged_in 的误导序列
 *     （koishi driver 收到 logged_in 但子进程无协议装配，上线后所有请求失败）；
 *     装配进行中的并发结果同样忽略（不干扰初次装配链）。
 *
 * 防重入（2026-09-08 拍板）：control login 全程互斥（claim/release）——在途
 * 登录/重装配期间的新指令直接忽略（仅留日志，不发登录消息，面板随首个流程
 * 的真实状态收敛）。
 */

import { getErrorMessage } from "../../internal/type-guards.js";
import { isShuttingDown, requestShutdown } from "../../lifecycle/shutdown.js";
import { sendLogin, sendQr, sendStatus } from "../ipc/index.js";
import type { CoreLike, LoginResultLike } from "../types.js";
import { log } from "../util.js";

/**
 * control login 抢占引用（2026-09-08）：初始登录竞速期间，control login
 * （如强制扫码）成功的结果经 resolve 接管 doLogin——否则快速登录风控挂起时
 * 强制扫码虽能出码登录，bootstrap 的 doLogin 永远不 settle，装配链不跑。
 */
export interface LoginPreemptRef {
    resolve: ((result: LoginResultLike) => void) | null;
}

/** 登录控制相位（初始竞速 → 装配 → ready 软重登窗口 / 失败中止）。 */
export type LoginControlPhase =
    | "login-race" // 初始 doLogin 竞速中（抢占口开放）
    | "assembling" // 竞速已结束、装配链运行中（并发 control login 结果忽略）
    | "ready" // 引导完成（软重登窗口：重装配路径可用）
    | "aborted"; // 引导失败、进程将退出（迟到结果不再上报）

/** 登录控制相位机（bootstrapWithCore 持有，handler 与引导链共享）。 */
export class LoginControl {
    private phase: LoginControlPhase = "login-race";
    private claimed = false;
    private readonly preempt: LoginPreemptRef;

    constructor(preempt: LoginPreemptRef) {
        this.preempt = preempt;
    }

    /** 当前相位。 */
    get currentPhase(): LoginControlPhase {
        return this.phase;
    }

    /** 取走竞速抢占口（登录期 control login 成功接管引导链用）；竞速已结束返回 null。 */
    takePreempt(): ((result: LoginResultLike) => void) | null {
        const resolve = this.preempt.resolve;
        if (resolve === null) {
            return null;
        }
        this.preempt.resolve = null;
        return resolve;
    }

    /** 竞速结束（初始登录 settle）：关抢占口，进入装配期。 */
    beginAssembly(): void {
        this.preempt.resolve = null;
        this.phase = "assembling";
    }

    /** 装配完成：开启软重登窗口。 */
    markReady(): void {
        this.phase = "ready";
    }

    /** 引导失败（进程将退出）：关抢占口，迟到 control login 结果不再上报。 */
    abort(): void {
        this.preempt.resolve = null;
        this.phase = "aborted";
    }

    /** control login 互斥（在途防重入）：同一时刻只允许一个 control login 流程。 */
    claim(): boolean {
        if (this.claimed) {
            return false;
        }
        this.claimed = true;
        return true;
    }

    /** 释放互斥（core.login settle 后调用，含软重登重装配完成）。 */
    release(): void {
        this.claimed = false;
    }
}

/** control login 依赖（bootstrapWithCore 注入重装配；单测可替换失败处理）。 */
export interface LoginControlDeps {
    /** ready 态软重登重装配（清理旧服务 + 用新登录结果重跑装配链）。 */
    reassemble(loginResult: LoginResultLike): Promise<boolean>;
    /**
     * 重装配失败处理（默认：上报 failed + 退出进程，交 koishi driver 重启循环
     * 回收——旧服务已清、新服务未立，进程不可再用）。单测注入 mock 防 process.exit。
     */
    onReassembleFailed?(): void;
}

/** 登录状态字面量（IPC login 消息，与 kernel LoginState 对齐）。 */
const LOGIN_STATES = ["idle", "waiting_scan", "scanned", "logged_in", "failed"] as const;
type LoginStateLike = (typeof LOGIN_STATES)[number];

/** 宽松收窄（kernel onLoginProgress.state 是 string；bootstrap-core 登录回调共用）。 */
function isLoginState(value: string): value is LoginStateLike {
    return LOGIN_STATES.some((s) => s === value);
}

export interface LoginProgressLike {
    state: string;
    qr?: { pngBase64: string; qrcodeUrl: string };
    selfInfo?: { uin: string; uid: string; nick: string };
    message?: string;
}

/** logged_in 由实际采纳登录结果的一方发布。 */
export function forwardIpcLoginProgress(progress: LoginProgressLike): void {
    if (progress.qr !== undefined) {
        sendQr(progress.qr.pngBase64, progress.qr.qrcodeUrl);
    }
    if (isLoginState(progress.state) && progress.state !== "logged_in") {
        sendLogin(progress.state, progress.selfInfo, progress.message);
    }
}

/** ready 态软重登：重装配 → 成功重播 ready/logged_in，失败交失败处理。 */
async function softReloginAndReport(
    loginResult: LoginResultLike,
    selfInfo: { uin: string; uid: string; nick: string },
    deps: LoginControlDeps,
    control: LoginControl,
): Promise<void> {
    control.beginAssembly();
    const ok = await deps.reassemble(loginResult).catch((err: unknown) => {
        log(`relogin: 软重登重装配异常: ${getErrorMessage(err)}`);
        return false;
    });
    if (isShuttingDown()) {
        return;
    }
    if (!ok) {
        control.abort();
        (deps.onReassembleFailed ?? defaultReassembleFailed)();
        return;
    }
    // 重播 ready（driver ready 幂等守卫不重复 onReady）+ 刷新 selfInfo
    //（换账号由 koishi 侧 checkIdentity 拒绝上线）
    control.markReady();
    sendStatus("ready", undefined, undefined, selfInfo);
    sendLogin("logged_in", selfInfo);
}

/** control login 成功结果按相位分派（抽取自 handler，控制认知复杂度）。 */
async function dispatchLoginSuccess(
    result: LoginResultLike,
    control: LoginControl,
    deps: LoginControlDeps,
): Promise<void> {
    const selfInfo = { uin: result.uin, uid: result.uid, nick: result.nick ?? "" };
    // ① 登录期抢占：初始 doLogin 仍在竞速等待时，用本结果接管引导链
    const preemptResolve = control.takePreempt();
    if (preemptResolve !== null) {
        preemptResolve(result);
        return;
    }
    // ② ready 态软重登：重装配（清理旧服务 + 重跑装配链）
    if (control.currentPhase === "ready") {
        await softReloginAndReport(result, selfInfo, deps, control);
        return;
    }
    // ③ assembling/aborted：迟到结果不上报（防 failed→logged_in 误导序列 /
    // 初次装配进行中不被并发重登干扰）
    log(`relogin: control login 成功但引导相位=${control.currentPhase}，忽略结果`);
}

/** 重装配失败默认处理：上报 failed + 退出进程（koishi driver 重启循环回收）。 */
function defaultReassembleFailed(): void {
    log("relogin: 软重登重装配失败，上报 failed 并退出（driver 重启循环接管）");
    sendStatus("failed", "软重登重装配失败", {
        code: "UNKNOWN",
        message: "软重登重装配失败，详见 napuketto-boot.log",
    });
    void requestShutdown("软重登装配失败", 1);
}

/**
 * control login 指令 → 重新登录（qr=true 强制扫码跳过快速登录，uin 指定账号）。
 * 成功结果按 LoginControl 相位分派（登录期抢占 / ready 软重登 / 忽略迟到）。
 * 该 handler 仅在 IPC 模式经 startIpcServer 的 onLogin 注册（见 bootstrapWithCore），
 * 非 IPC 模式无 control 通道不会触达，故无条件走 JSON 行协议、无需再判 ipcMode。
 */
export function createLoginControlHandler(
    core: CoreLike,
    Appid: string | number,
    control: LoginControl,
    deps: LoginControlDeps,
): (payload: { uin?: string; qr?: boolean }) => void {
    return (payload) => {
        const phase = control.currentPhase;
        if (isShuttingDown() || phase === "assembling" || phase === "aborted" || !control.claim()) {
            log("relogin: 当前相位或在途登录禁止新的 control login");
            return;
        }
        const isCurrent = () => !isShuttingDown() && control.currentPhase === phase;
        const opts: Record<string, unknown> = {
            appid: String(Appid),
            initTimeoutMs: 20000,
            quickLoginTimeoutMs: 20000,
            qrFallback: true,
            ...(payload.uin !== undefined ? { quickUin: payload.uin } : {}),
            ...(payload.qr === true ? { qrOnly: true } : {}),
            onLoginProgress: (progress: LoginProgressLike) => {
                if (isCurrent()) {
                    forwardIpcLoginProgress(progress);
                }
            },
        };
        void core
            .login(opts)
            .then(async (result) => {
                if (!isCurrent()) {
                    return;
                }
                if (result === null) {
                    sendLogin("failed", undefined, "登录返回空结果");
                    return;
                }
                await dispatchLoginSuccess(result, control, deps);
            })
            .catch((err) => {
                log(`bootstrap: control login 失败: ${getErrorMessage(err)}`);
                if (isCurrent()) {
                    sendLogin("failed", undefined, getErrorMessage(err));
                }
            })
            .finally(() => {
                control.release();
            });
    };
}
