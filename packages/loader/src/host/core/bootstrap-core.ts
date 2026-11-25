/**
 * bootstrap-core.ts：NapukettoCore 装配路径（从 bootstrap.ts 拆分，2026-08-08 FTA 优化）。
 *
 * NapukettoCore.create → attachWrapper → 登录（pickLoginAccount + doLogin）→
 * session 替换/激活 → 就绪等待 → 冒烟自检 → 协议装配 → 探测模式。
 */
import { basename, dirname, join } from "node:path";
import process from "node:process";
import { getErrorMessage, hasCallableProp } from "../../internal/type-guards.js";
import { isShuttingDown, registerShutdownHook } from "../../lifecycle/shutdown.js";
import { QR_LINE_PREFIX } from "../constants.js";
import { consumeQrOnlyMarker, env, isEnvEnabled } from "../env.js";
import {
    attachIpcServices,
    attachOb11IpcBridge,
    createIpcActionsForCore,
    type IpcServerOptions,
    sendLogin,
    sendStatus,
    startIpcServer,
} from "../ipc/index.js";
import { resolveLoaderLogConfig, resolveLogFilePath } from "../log-config.js";
import type { CoreContextLike, CoreLike, KernelLike, LoginResultLike } from "../types.js";
import { log, type SharedState } from "../util.js";
import type { KernelServices } from "./kernel-services.js";
import { doLogin, type LoginTargetRef, pickLoginAccount } from "./login.js";
import { startProtocols } from "./protocols.js";
import {
    createLoginControlHandler,
    forwardIpcLoginProgress,
    LoginControl,
    type LoginPreemptRef,
    type LoginProgressLike,
} from "./relogin.js";
import {
    collectCandidateSessions,
    isSessionUsable,
    pickBestSession,
    probeSessionMethods,
    type SessionCandidate,
    startSessionProbe,
} from "./session.js";
import { runSmokeTest } from "./smoke.js";

/** 引导环境（qqVersion / dataDir / dataRoot / wrapperPath，来自 env）。 */
export interface BootstrapEnv {
    qqVersion: string;
    dataDir: string;
    /** 数据根（Linux 和调试沙箱下 QQ 数据存放在 `<dataRoot>/nt_qq`）。 */
    dataRoot: string;
    wrapperPath: string;
}

/** 探测：create() 与捕获的 QQ session 关系（确认 create() 是否干扰 QQ）。 */
function probeCreatedSession(state: SharedState, ctx: CoreContextLike): void {
    try {
        const S2 = state.wrapperExports?.["NodeIQQNTWrapperSession"];
        const created = hasCallableProp(S2, "create") ? S2.create() : null;
        log(
            `BOOT: create()===qqSession? ${created === state.qqSession} | create()===ctx.session? ${created === ctx.session} | qqSession===ctx.session? ${state.qqSession === ctx.session}`,
        );
        const svc = hasCallableProp(created, "getMsgService") ? created.getMsgService() : null;
        const qs = state.qqSession;
        const qsReady =
            hasCallableProp(qs, "getMsgService") &&
            qs.getMsgService() !== null &&
            qs.getMsgService() !== undefined;
        log(
            `BOOT: create().getMsgService=${svc !== null && svc !== undefined ? "ready" : "null"} qqSession.getMsgService=${qsReady ? "ready" : "null"}`,
        );
    } catch (e) {
        log(`BOOT: create() 探测失败: ${getErrorMessage(e)}`);
    }
}

/** 登录参数（NAPUKETTO_QUICK_UIN 强制指定 / ref 目标 / qrOnly 强制扫码 / 默认）。 */
function buildLoginOpts(
    Appid: string | number,
    forcedUin: string | undefined,
    ref: LoginTargetRef,
    qrOnly: boolean,
    isCurrent: () => boolean,
): Record<string, unknown> {
    const quickUin = qrOnly ? undefined : (forcedUin ?? ref.targetUin);
    const opts: Record<string, unknown> = {
        appid: Appid,
        initTimeoutMs: 20000,
        ...(quickUin !== undefined ? { quickUin } : {}),
        ...(qrOnly ? { qrOnly: true } : {}),
    };
    const ipcMode = isEnvEnabled(env.NAPUKETTO_IPC);
    // 登录进度回调：QR 阶段透出二维码数据（cli 终端渲染 / koishi IPC 转发共用）。
    //  - IPC 模式：走 JSON 行协议 sendQr/sendLogin（koishi 插件驱动，不变）
    //  - cli 自建宿主模式：QR 数据以 NAPUTO_QR 标记行输出 stdout，由 cli
    //    forwardFiltered 解析后用 uqr 编码渲染终端二维码（qr.ts；png 落盘由 kernel 完成）
    opts["onLoginProgress"] = (progress: LoginProgressLike) => {
        if (!isCurrent()) {
            return;
        }
        if (ipcMode) {
            forwardIpcLoginProgress(progress);
        } else if (progress.qr !== undefined) {
            const { pngBase64, qrcodeUrl } = progress.qr;
            process.stdout.write(`${QR_LINE_PREFIX}${JSON.stringify({ pngBase64, qrcodeUrl })}\n`);
        }
    };
    return opts;
}

/** V2 登录后替换 session：优先 QQ 主 session，其次 vehicle 单例表；自建宿主例外。 */
function replaceSession(
    kernel: KernelLike,
    core: CoreLike,
    state: SharedState,
    ctx: CoreContextLike,
): SessionCandidate | null {
    // 自建宿主（NAPUKETTO_SELF_HOST）例外：无 QQ 主进程/vehicle/qqSession 捕获，
    // 且 getMainSession 内部会先 startupSession.start()——与「先 init 后 start」
    // 顺序冲突（HANDOVER-V9 实证）；登录前 createSession 创建的配套 session
    // （ctx.session + ctx.startupSession）才是正确激活目标。
    const isSelfHost = isEnvEnabled(env.NAPUKETTO_SELF_HOST);
    if (isSelfHost) {
        return null;
    }
    const candidates = collectCandidateSessions(state, kernel, ctx);
    const chosen = pickBestSession(candidates);
    if (chosen && chosen.s !== ctx.session) {
        core.setSession(chosen.s);
        log(
            `bootstrap: 已替换 session（来源=${chosen.tag}，msgSvc=${isSessionUsable(chosen.s) ? "READY" : "null"}）`,
        );
    } else if (chosen) {
        log(`bootstrap: 候选 session 与 ctx.session 相同（${chosen.tag}）`);
    } else {
        log("bootstrap: 无有效候选 session（保留 kernel 自建 session）");
    }
    return chosen;
}

/**
 * 激活目标 session（先 init 后 startupSession.start，HANDOVER-V6 三要素）。
 * 自建宿主无候选时对 kernel 自建 session 走 NapCat 激活。
 */
async function activateSession(
    kernel: KernelLike,
    state: SharedState,
    ctx: CoreContextLike,
    chosen: SessionCandidate | null,
    loginResult: LoginResultLike,
    Appid: string | number,
    bootEnv: BootstrapEnv,
): Promise<void> {
    const activateTarget: SessionCandidate = chosen ?? {
        s: ctx.session,
        tag: "kernel 自建 session",
    };
    if (!activateTarget.s || isSessionUsable(activateTarget.s)) {
        return;
    }
    log(`bootstrap: 激活 session（${activateTarget.tag}，先 init 后 startupSession.start）...`);
    try {
        // session 数据目录指向 QQ 真实数据目录（数据根/nt_qq/global，HANDOVER-V6 三要素之三）：
        // cfgDir 下 init 的 onOpentelemetryInit 不触发（p0-kernel-flow 实证——accountPath 必须是 nt_qq/global）。
        const qqDataRoot =
            typeof kernel.resolveQqUserDataRoot === "function"
                ? kernel.resolveQqUserDataRoot(
                      state.wrapperExports,
                      bootEnv.dataRoot !== "" ? { dataRoot: bootEnv.dataRoot } : {},
                  )
                : null;
        const accountPath =
            qqDataRoot && typeof kernel.resolveQqGlobalPath === "function"
                ? kernel.resolveQqGlobalPath(qqDataRoot)
                : bootEnv.dataDir || ".";
        // 设备指纹 guid：loginService.getMachineGuid()（kernel 原生反射，反风控）。
        const machineGuid =
            typeof kernel.readMachineGuid === "function"
                ? kernel.readMachineGuid(ctx.loginService)
                : "";
        const sessionConfig = kernel.buildSessionConfig({
            appid: Appid,
            fullVersion: bootEnv.qqVersion || "",
            selfUin: loginResult.uin,
            selfUid: loginResult.uid,
            accountPath,
            downloadPath: join(accountPath, "NapCat", "temp"),
            machineGuid,
        });
        const listener = kernel.createLifecycleSessionListener();
        // initAndStartSession 已修正：先 session.init 再 startupSession.start()
        await kernel.initAndStartSession(ctx, sessionConfig, listener, {
            timeoutMs: 20000,
        });
        log("bootstrap: 激活 session init + start 完成");
    } catch (initErr) {
        log(`bootstrap: 激活 session init 失败: ${getErrorMessage(initErr)}`);
    }
}

/** 等 session 就绪（getMsgService 非 null）——init 完成后才有。 */
async function waitSessionReady(kernel: KernelLike, ctx: CoreContextLike): Promise<void> {
    try {
        await kernel.waitSessionReady(ctx, { timeoutMs: 30000 });
        log("bootstrap: QQ session 就绪（getMsgService 可用）");
    } catch (readyErr) {
        log(`bootstrap: 等待 session 就绪失败: ${getErrorMessage(readyErr)}`);
    }
}

/** P2-1 收发消息冒烟自检（NAPUKETTO_SMOKE=1）：MsgBridge + MsgApi 真发/收一条。 */
async function runSmokeIfEnabled(
    kernel: KernelLike,
    ctx: CoreContextLike,
    loginResult: LoginResultLike,
): Promise<void> {
    if (!isEnvEnabled(env.NAPUKETTO_SMOKE)) {
        return;
    }
    try {
        const ok = await runSmokeTest(kernel, ctx, loginResult);
        log(`bootstrap: 冒烟自检${ok ? "通过" : "未完全通过"}（见上文 smoke 日志）`);
    } catch (smokeErr) {
        log(`bootstrap: 冒烟自检异常: ${getErrorMessage(smokeErr)}`);
    }
}

/** 立即探测一次（NAPUKETTO_PROBE=1）：fallback / core 两处引导路径共用的探测原语。 */
export function probeOnce(kernel: KernelLike, ctx: CoreContextLike): void {
    if (!isEnvEnabled(env.NAPUKETTO_PROBE) || typeof kernel.probeRuntime !== "function") {
        return;
    }
    try {
        const probe = kernel.probeRuntime(ctx);
        log(
            `bootstrap: probe done, session=${probe.session ? "ok" : "null"}, services=${Object.keys(probe.services ?? {}).length}`,
        );
    } catch (e) {
        log(`bootstrap: probe error: ${getErrorMessage(e)}`);
    }
}

/**
 * listener 录制模式（NAPUKETTO_LISTENER_RECORD=1，批次三前置）：万能监听器挂满
 * 候选服务，回调逐行落盘 napuketto-listener-record.jsonl。
 * ⚠️ 必须先于 runProbePhase——probe 的 getMainSession 写回副作用会毒化
 * ctx.session（空壳主 session），录制器要先取服务。
 */
function runListenerRecordingPhase(kernel: KernelLike, ctx: CoreContextLike): void {
    if (!isEnvEnabled(env.NAPUKETTO_LISTENER_RECORD)) {
        return;
    }
    if (typeof kernel.startListenerRecording !== "function") {
        log("bootstrap: listener-record 请求但 kernel 缺 startListenerRecording（kernel 过旧）");
        return;
    }
    try {
        const rec = kernel.startListenerRecording(ctx);
        const ok = Object.values(rec.registered).filter((r) => r.ok).length;
        const total = Object.keys(rec.registered).length;
        log(`bootstrap: listener-record 挂起 ${ok}/${total} 服务 → ${rec.file}`);
        for (const [name, r] of Object.entries(rec.registered)) {
            if (!r.ok) {
                log(`bootstrap: listener-record ${name} 未挂: ${r.error ?? "unknown"}`);
            }
        }
    } catch (e) {
        log(`bootstrap: listener-record error: ${getErrorMessage(e)}`);
    }
}

/** 探测模式（NAPUKETTO_PROBE=1）：立即探测 + 35s 后晚探测（napuketto-probe-late.json）。 */
function runProbePhase(kernel: KernelLike, ctx: CoreContextLike): void {
    if (!isEnvEnabled(env.NAPUKETTO_PROBE)) {
        return;
    }
    probeOnce(kernel, ctx);
    const lateProbeTimer = setTimeout(() => {
        try {
            if (typeof kernel.probeRuntime !== "function") {
                return;
            }
            const late = kernel.probeRuntime(ctx, "napuketto-probe-late.json");
            log(
                `bootstrap: probe-late done, session=${late.session ? "ok" : "null"}, services=${Object.keys(late.services ?? {}).length}`,
            );
        } catch (e2) {
            log(`bootstrap: probe-late error: ${getErrorMessage(e2)}`);
        }
    }, 35000);
    // 晚探测定时器不阻塞进程自然退出
    lateProbeTimer.unref?.();
    registerShutdownHook(() => clearTimeout(lateProbeTimer), "intake");
}

/**
 * kernel 数据根 / 账号目录：`paths.dataRoot` 传全局数据根、`paths.account` 传账号目录名，
 * 使 `ctx.paths.root` 是数据根（Linux 下 QQ 数据根 = `<数据根>/nt_qq`，所有账号共享，
 * 与 Windows QQ 数据目录语义一致）。`NAPUKETTO_DATA_ROOT` 缺失或不是账号目录父级时
 * 退化为「账号目录当数据根」（旧行为，Windows 不受影响）。
 */
function resolveKernelPaths(bootEnv: BootstrapEnv): { dataRoot: string; account?: string } {
    if (bootEnv.dataRoot !== "" && dirname(bootEnv.dataDir) === bootEnv.dataRoot) {
        return { dataRoot: bootEnv.dataRoot, account: basename(bootEnv.dataDir) };
    }
    return { dataRoot: bootEnv.dataDir };
}

/** NapukettoCore.create 选项（[log] 段 + env 折叠；IPC 模式关 console）。 */
function buildCoreCreateOptions(
    logCfg: ReturnType<typeof resolveLoaderLogConfig>,
    bootEnv: BootstrapEnv,
): Parameters<NonNullable<KernelLike["NapukettoCore"]>["create"]>[0] {
    return {
        paths: resolveKernelPaths(bootEnv),
        logLevel: logCfg.levels.kernel ?? logCfg.level,
        ...(logCfg.format !== undefined ? { logFormat: logCfg.format } : {}),
        ...(logCfg.timestamp !== undefined ? { logTimestamp: logCfg.timestamp } : {}),
        ...(logCfg.colorize !== undefined ? { logColorize: logCfg.colorize } : {}),
        ...(logCfg.file !== undefined
            ? {
                  logFile: resolveLogFilePath(logCfg.file.path),
                  logFileLevel: logCfg.file.level,
              }
            : {}),
        ...(env.NAPUKETTO_QUICK_UIN !== undefined ? { account: env.NAPUKETTO_QUICK_UIN } : {}),
        // IPC 模式关 console：stdout 专用于 JSON 行协议，控制台日志并发写会
        // 撕裂协议行（2026-09-06「能收不能发」事故根因）；文件日志
        // logs/napuketto.log 不受影响，cli 模式 console 输出不变
        ...(isEnvEnabled(env.NAPUKETTO_IPC) ? { consoleLog: false } : {}),
    };
}

function mountIpcLogin(
    ipc: IpcServerOptions,
    core: CoreLike,
    onLogin: NonNullable<IpcServerOptions["onLogin"]>,
    startServer: boolean,
): void {
    for (const [name, handler] of createIpcActionsForCore(core)) {
        ipc.actions.set(name, handler);
    }
    ipc.onLogin = onLogin;
    if (startServer) {
        registerShutdownHook(startIpcServer(ipc), "intake");
    }
}

/** NapukettoCore 装配路径：create → attachWrapper → 登录 → 激活 → 协议 → 探测。
 * @returns 引导是否完整完成（协议服务装配成功 = true；登录失败/服务装配失败等
 *   静默收敛为 false，具体原因见 napuketto-boot.log）。 */
export async function bootstrapWithCore(
    kernel: KernelLike,
    state: SharedState,
    bootEnv: BootstrapEnv,
    Appid: string | number,
    hostIpc?: IpcServerOptions,
): Promise<boolean> {
    // 日志配置（napuketto.toml [log] 段 + env 覆盖；失败回退缺省）——kernel 与
    // loader 两个 logger 的格式/级别/时间戳统一从这里来（2026-10-25 日志可配置化）
    const logCfg = resolveLoaderLogConfig(kernel);
    // 装配层路径：NapukettoCore.create → attachWrapper → login
    const coreCtor = kernel.NapukettoCore;
    if (coreCtor === undefined) {
        return false;
    }
    const core: CoreLike = coreCtor.create(buildCoreCreateOptions(logCfg, bootEnv));

    // ⭐ IPC 模式：登录前就启动 stdin 服务端（只含 login.refreshQr 动作）。
    // 否则登录中（waiting_scan）前端刷新/control 指令堆积在 pipe 缓冲区，
    // 子进程不读 stdin → 指令不可达；同时心跳 ping（15s）提前启动，
    // 防扫码耗时超过 45s 被 driver 误判失联强杀（2026-08-13 结构性修复）。
    const ipc = hostIpc ?? (isEnvEnabled(env.NAPUKETTO_IPC) ? { actions: new Map() } : undefined);
    // control login 抢占（2026-09-08）：初始登录竞速——doLogin 与 control login
    // 先 settle 者胜。快速登录风控挂起时「强制扫码」control login 成功的结果
    // 接管引导链（否则 doLogin 永远不 settle，出码登录成功也到不了 ready）。
    const preempt: LoginPreemptRef = { resolve: null };
    const preemptLogin = new Promise<LoginResultLike>((resolve) => {
        preempt.resolve = resolve;
    });
    // 登录控制相位机（A1/A2，relogin.ts）：登录竞速 → 装配 → ready（软重登窗口）
    const control = new LoginControl(preempt);
    // 软重登延迟绑定：IPC 服务端先于 attachWrapper 启动（登录期 control 指令
    // 可达优先），softRelogin 闭包依赖 ctx，就绪后注入。相位机保证 ready 态
    // （装配完成后）才会触达软重登路径，届时必已绑定。
    const reassembleRef: {
        current: ((loginResult: LoginResultLike) => Promise<boolean>) | null;
    } = { current: null };
    if (ipc !== undefined) {
        mountIpcLogin(
            ipc,
            core,
            createLoginControlHandler(core, Appid, control, {
                reassemble: (loginResult) =>
                    reassembleRef.current?.(loginResult) ?? Promise.resolve(false),
            }),
            hostIpc === undefined,
        );
    }
    registerShutdownHook(() => control.abort(), "intake");

    // 不传 qqSession/qqLoginService（登录前捕获的旧实例已失效/会干扰；
    // framework 语义：登录成功后 kernel 自己 create+init）
    const ctx = core.attachWrapper(state.wrapperExports, { ...bootEnv });
    log(
        `bootstrap: attachWrapper OK, engine=${typeof ctx.engine}, session=${ctx.session !== null}`,
    );

    let services: KernelServices | null = null;
    let stopIpcServices: (() => void) | null = null;
    let stopOb11Bridge: (() => void) | null = null;

    async function stopProtocols(): Promise<void> {
        const stopBridge = stopOb11Bridge;
        stopOb11Bridge = null;
        try {
            stopBridge?.();
        } finally {
            await services?.stopAdapters?.();
        }
    }

    function disposeServices(): void {
        const stopIpc = stopIpcServices;
        const current = services;
        stopIpcServices = null;
        services = null;
        try {
            stopIpc?.();
        } finally {
            current?.dispose();
        }
    }

    registerShutdownHook(stopProtocols, "protocols");
    registerShutdownHook(disposeServices);

    async function prepareSession(loginResult: LoginResultLike, initial: boolean): Promise<void> {
        const chosen = replaceSession(kernel, core, state, ctx);
        await activateSession(kernel, state, ctx, chosen, loginResult, Appid, bootEnv);
        if (isShuttingDown()) {
            return;
        }
        await waitSessionReady(kernel, ctx);
        if (initial && !isShuttingDown()) {
            if (ipc !== undefined) {
                sendStatus("sessioning");
            }
            await runSmokeIfEnabled(kernel, ctx, loginResult);
        }
    }

    async function attachIpc(newServices: KernelServices): Promise<void> {
        if (ipc === undefined) {
            return;
        }
        stopIpcServices = attachIpcServices(ipc.actions, newServices);
        const stopBridge = await attachOb11IpcBridge(ipc.actions, newServices);
        if (isShuttingDown()) {
            stopBridge();
        } else {
            stopOb11Bridge = stopBridge;
        }
    }

    /** 初次引导与软重登共用，关停期间不发布新的装配结果。 */
    const runAssembly = async (
        loginResult: LoginResultLike,
        initial: boolean,
    ): Promise<boolean> => {
        await prepareSession(loginResult, initial);
        if (isShuttingDown()) {
            return false;
        }
        const newServices = await startProtocols(kernel, ctx, loginResult, logCfg);
        if (newServices === null) {
            log("bootstrap: 协议服务装配失败，引导中止");
            return false;
        }
        if (isShuttingDown()) {
            try {
                await newServices.stopAdapters?.();
            } finally {
                newServices.dispose();
            }
            return false;
        }
        services = newServices;
        await attachIpc(newServices);
        return !isShuttingDown();
    };

    /**
     * 软重登重装配（ready 态 control login 成功，relogin.ts 经 deps 调用）：
     * 清理旧装配面 → 用新登录结果重跑装配链（A2，2026-09-08）。
     * 清理顺序：协议消费方（OB11 桥退订+动作表移除）→ IPC 事件转发/动作表
     * → kernel 桥/缓存/消息日志（dispose，幂等）。失败返回 false（上报退出）。
     */
    const softRelogin = async (loginResult: LoginResultLike): Promise<boolean> => {
        sendStatus("sessioning");
        log(`bootstrap: 软重登 uin=${loginResult.uin}——清理旧装配并重跑装配链`);
        try {
            await stopProtocols();
        } finally {
            disposeServices();
        }
        if (isShuttingDown()) {
            return false;
        }
        return await runAssembly(loginResult, false);
    };
    reassembleRef.current = softRelogin;

    probeCreatedSession(state, ctx);
    // 多源 session 就绪探测（5s 间隔，60s 上限）
    const sessionProbe = startSessionProbe(state, ctx);
    registerShutdownHook(() => clearInterval(sessionProbe), "intake");
    // 探测 session 方法面（NAPI 反射，验证 startNT/init 等关键方法）
    probeSessionMethods(ctx);

    if (typeof core.login !== "function") {
        log("bootstrap: kernel core missing login fn");
        control.abort();
        return false;
    }
    // NAPUKETTO_QUICK_UIN 强制指定快速登录账号（cli `-q <uin>` 透传，2026-08-07；
    // 也用于实验/自建宿主验证，防止自动选中风控账号 3054108135 导致挂起）。
    // NAPUKETTO_QR_ONLY 强制扫码（2026-09-08）：跳过快速登录直接 QR——
    // koishi 面板「扫码登录」的重启路径（qrOnly 一次性，登录后 env 不再生效）。
    // 打印可用快速登录账号（启动横幅）
    const forcedUin = env.NAPUKETTO_QUICK_UIN;
    // 一次性扫码标记：读取即消费（从 process.env 删除），软重登/重试不被残留标记强制扫码。
    const qrOnly = consumeQrOnlyMarker();
    const ref: LoginTargetRef = { targetUin: undefined };
    await pickLoginAccount(kernel, ctx, ref, forcedUin);
    if (isShuttingDown()) {
        return false;
    }
    if (ipc !== undefined) {
        sendStatus("logging");
    }
    const loginResult = await Promise.race([
        doLogin(
            core,
            buildLoginOpts(
                Appid,
                forcedUin,
                ref,
                qrOnly,
                () => control.currentPhase === "login-race" && !isShuttingDown(),
            ),
        ),
        preemptLogin,
    ]);
    // 竞速结束：关抢占口进入装配期（后续 control login 走 ready 态软重登
    // 或按相位忽略，见 relogin.ts 相位机——A1 修复迟到结果的误导上报）
    if (isShuttingDown()) {
        return false;
    }
    control.beginAssembly();
    if (loginResult === null) {
        control.abort();
        log("bootstrap: 登录失败，引导中止");
        sendStatus("failed", "登录失败", { code: "NOT_LOGIN", message: "登录失败" });
        return false;
    }
    log(
        `bootstrap: 登录成功 uin=${loginResult.uin} uid=${loginResult.uid} nick=${loginResult.nick}`,
    );
    if (isEnvEnabled(env.NAPUKETTO_IPC)) {
        sendLogin("logged_in", {
            uin: loginResult.uin,
            uid: loginResult.uid,
            nick: loginResult.nick ?? "",
        });
    }

    if (!(await runAssembly(loginResult, true))) {
        control.abort();
        return false;
    }
    // 装配完成：开启软重登窗口（control login 原地重登 + 重装配）
    control.markReady();
    // listener 录制模式（先于探测——时序硬约束见 runListenerRecordingPhase）
    runListenerRecordingPhase(kernel, ctx);
    // 探测模式
    runProbePhase(kernel, ctx);
    if (ipc !== undefined) {
        sendStatus("ready", undefined, undefined, {
            uin: loginResult.uin,
            uid: loginResult.uid,
            nick: loginResult.nick ?? "",
        });
    }
    return true;
}
