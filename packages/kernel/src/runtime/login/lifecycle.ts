/**
 * 完整启动生命周期（wrapper.node 契约流程，2026-08-05 实测确认，自研实现）
 *
 * 启动顺序由 wrapper.node 外部契约决定（engine→login→session→startNT），
 * 运行时实测确认，自研实现：
 *  1. engine.initWithDeskTopConfig（appid/qua/版本）
 *  2. loginService.initConfig + addKernelLoginListener
 *  3. getLoginList() → quickLoginWithUin(uin)（或 QR 登录）
 *  4. 登录成功 → genSessionConfig → session.init(config, 3 adapter, listener) → startNT(0)
 *  5. 等 init 完成信号（onOpentelemetryInit(is_init) 为主，onSessionInitComplete 为辅）
 *
 * 关键（2026-08-05 实测修正）：
 *  - session 用 `new wrapper.NodeIQQNTWrapperSession()` 创建；exports 不含 NodeI*Adapter/Listener
 *    构造器（89 键实测无）——adapter 与 listener 一律传普通 JS 对象（NAPI 反射读取方法回调）。
 *
 * 模块边界（2026-08-05 解耦；2026-08-08 FTA 优化再拆）：
 *  - 配置装配（buildEngineConfig / buildLoginConfig / buildSessionConfig）→ wrapper-config.ts
 *  - NAPI 回调适配器（GlobalAdapter / DependsAdapter / DispatcherAdapter / listener 工厂）→ wrapper-adapters.ts
 *  - 登录连接 + 快速登录（waitForNetworkConnection / quickLogin 等）→ msf-connection.ts / quick-login.ts
 *  - 本文件只保留 session 流程编排：就绪等待（waitSessionReady）+ session 初始化（initAndStartSession）。
 */

import { kernelError, waitFor } from "../../infra/index.js";
import type { WrapperContext } from "../../native/wrapper/lifecycle.js";
import {
    createSessionListener,
    DependsAdapter,
    DispatcherAdapter,
} from "../../native/wrapper/wrapper-adapters.js";
import type { NodeIKernelSessionListener, WrapperSessionInitConfig } from "../../types/index.js";

export { waitForNetworkConnection } from "./msf-connection.js";
export type { LoginAccountInfo, LoginResult, QuickLoginOptions } from "./quick-login.js";
export { listLoginAccounts, quickLogin } from "./quick-login.js";

/** session init 默认超时（毫秒）。 */
const DEFAULT_INIT_TIMEOUT_MS = 15_000;

/** session 就绪等待默认超时（毫秒）。 */
const SESSION_READY_TIMEOUT_MS = 30_000;

/** session 就绪轮询间隔（毫秒）。 */
const SESSION_READY_POLL_MS = 1000;

/**
 * 等待 QQ 自己完成 session 初始化（framework 复用模式，2026-08-05 修正）。
 *
 * 背景：QQ 9.9.31 实测——session 由 QQ 主进程自己创建并 init（登录后）。
 * 我们不自己 init（重复 init 断言 "implementation of IQQNTWrapperSession is not valid"），
 * 也不自己 create（登录前 create() 干扰 QQ，实测 QQ 退出 code=0）。
 * 正确做法：等 QQ 的 session 就绪（getMsgService 非 null = 核心 service 已挂载）。
 */
export async function waitSessionReady(
    ctx: WrapperContext,
    opts: { timeoutMs?: number | undefined } = {},
): Promise<void> {
    const { session } = ctx;
    if (session === null || session === undefined) {
        throw kernelError("session 未创建", "INVALID_STATE");
    }
    const ok = await waitFor(
        () => {
            try {
                const svc = session.getMsgService();
                return svc !== null && svc !== undefined;
            } catch {
                return false;
            }
        },
        opts.timeoutMs ?? SESSION_READY_TIMEOUT_MS,
        SESSION_READY_POLL_MS,
    );
    if (!ok) {
        throw kernelError("等待 QQ session 就绪超时（QQ 未完成 init）", "TIMEOUT");
    }
}

/** 登录连接 + 快速登录（quickLogin 等）已拆到 msf-connection.ts / quick-login.ts（见文件头 re-export）。 */

/** session 初始化（4 参全为普通 JS 对象，等 init 完成信号）。 */
export async function initAndStartSession(
    ctx: WrapperContext,
    config: WrapperSessionInitConfig,
    listener: NodeIKernelSessionListener = createSessionListener(),
    opts: { timeoutMs?: number | undefined } = {},
): Promise<void> {
    const { session } = ctx;
    if (session === null || session === undefined) {
        throw kernelError("session 未创建", "INVALID_STATE");
    }

    // adapter / listener 全部用普通 JS 对象（实测 exports 89 键无 NodeI*Adapter/Listener
    // 构造器；NAPI 反射读取对象方法回调，自研实现）。
    const depends = new DependsAdapter();
    const dispatcher = new DispatcherAdapter();

    const initComplete = watchInitSignal(listener);
    session.init(config, depends, dispatcher, listener);
    startSessionBestEffort(ctx, session);

    const ok = await Promise.race([
        initComplete.then(() => true),
        waitFor(() => false, opts.timeoutMs ?? DEFAULT_INIT_TIMEOUT_MS).then(() => false),
    ]);
    if (!ok) {
        throw kernelError("session init 超时", "TIMEOUT");
    }
}

/** 监听 init 完成信号：onOpentelemetryInit(is_init) 为主，onSessionInitComplete(0) 为辅。 */
function watchInitSignal(listener: NodeIKernelSessionListener): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const onOpentelemetry = listener.onOpentelemetryInit;
        listener.onOpentelemetryInit = (info) => {
            if (info.is_init) {
                resolve();
            }
            if (typeof onOpentelemetry === "function") {
                onOpentelemetry(info);
            }
        };
        const onInitComplete = listener.onSessionInitComplete;
        listener.onSessionInitComplete = (r) => {
            if (r === 0 || r === "0") {
                resolve();
            } else {
                reject(kernelError(`session init 失败: ${String(r)}`, "UNKNOWN"));
            }
            if (typeof onInitComplete === "function") {
                onInitComplete(r);
            }
        };
    });
}

/**
 * 启动会话（best effort，失败不致命）：
 * **先 init 后 start（2026-08-07 V9 决定性修正）**。
 * 自建宿主实测（HANDOVER-V9，p0-napcat-min）：必须先 session.init 再
 * startupSession.start()——顺序颠倒（先 start 后 init）业务 service 不挂载
 * （getMsgService null）；init 后用 startNT（非 startupSession.start）也失败。
 * NapCat initializeSession 同款：有 startupSession 用 start()，否则 startNT(0)。
 */
function startSessionBestEffort(
    ctx: WrapperContext,
    session: NonNullable<WrapperContext["session"]>,
): void {
    if (startupSessionStart(ctx)) {
        return;
    }
    try {
        session.startNT(0);
    } catch {
        try {
            session.startNT();
        } catch {
            // 无 startNT（9.9.31）：忽略，等 init 完成信号
        }
    }
}

/** 有 startupSession 则 start()（失败不致命），返回是否已处理。 */
function startupSessionStart(ctx: WrapperContext): boolean {
    const { startupSession } = ctx;
    if (startupSession === null || typeof startupSession.start !== "function") {
        return false;
    }
    try {
        startupSession.start();
    } catch {
        // start 失败不致命，靠 onOpentelemetryInit/onSessionInitComplete 信号判断
    }
    return true;
}
