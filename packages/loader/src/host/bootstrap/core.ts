/**
 * bootstrap/core.ts：NapukettoCore 装配路径主流程编排（create → attachWrapper → 登录 → 装配 → 探测相位）。
 * session 编排在 session.ts、观测相位在 bootstrap/probe.ts、软重登相位机在 auth/relogin.ts；本文件只留编排。
 */
import { basename, dirname } from "node:path";
import { isShuttingDown, registerShutdownHook } from "../../lifecycle/shutdown.js";
import { log } from "../../shared/boot-log.js";
import { doLogin, type LoginTargetRef, pickLoginAccount } from "../auth/login.js";
import {
    buildLoginOpts,
    createLoginControlHandler,
    LoginControl,
    type LoginPreemptRef,
} from "../auth/relogin.js";
import {
    activateSession,
    probeCreatedSession,
    probeSessionMethods,
    replaceSession,
    startSessionProbe,
    waitSessionReady,
} from "../auth/session.js";
import { attachIpcServices, createIpcActionsForCore } from "../ipc/attach.js";
import { attachOb11IpcBridge } from "../ipc/ob11-bridge.js";
import { sendLogin, sendStatus } from "../ipc/sender.js";
import { type IpcServerOptions, startIpcServer } from "../ipc/server.js";
import { startProtocols } from "../protocols/protocols.js";
import { consumeQrOnlyMarker, env, isEnvEnabled } from "../runtime/env.js";
import { resolveLoaderLogConfig, resolveLogFilePath } from "../runtime/log-config.js";
import type { SharedState } from "../runtime/state.js";
import type { BootstrapEnv, CoreLike, KernelLike, LoginResultLike } from "../runtime/types.js";
import { createAssemblyLifecycle } from "./assembly-lifecycle.js";
import { runListenerRecordingPhase, runProbePhase, runSmokeIfEnabled } from "./probe.js";

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
        // 撕裂协议行（「能收不能发」事故根因）；文件日志
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
    // loader 两个 logger 的格式/级别/时间戳统一从这里来
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
    // 防扫码耗时超过 45s 被 driver 误判失联强杀。
    const ipc = hostIpc ?? (isEnvEnabled(env.NAPUKETTO_IPC) ? { actions: new Map() } : undefined);
    // control login 抢占：初始登录竞速——doLogin 与 control login
    // 先 settle 者胜。快速登录风控挂起时「强制扫码」control login 成功的结果
    // 接管引导链（否则 doLogin 永远不 settle，出码登录成功也到不了 ready）。
    const preempt: LoginPreemptRef = { resolve: null };
    const preemptLogin = new Promise<LoginResultLike>((resolve) => {
        preempt.resolve = resolve;
    });
    // 登录控制相位机（relogin.ts）：登录竞速 → 装配 → ready（软重登窗口）
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

    // 非 IPC 模式没有 IPC 装配面：两个挂载协作者退化为空停止函数。
    const noop = (): void => {
        // 无 IPC 通道时无需清理
    };
    const assembly = createAssemblyLifecycle({
        startProtocols: (loginResult) => startProtocols(kernel, ctx, loginResult, logCfg),
        attachIpcServices: (newServices) =>
            ipc === undefined ? noop : attachIpcServices(ipc.actions, newServices),
        attachOb11IpcBridge: (newServices) =>
            ipc === undefined
                ? Promise.resolve(noop)
                : attachOb11IpcBridge(ipc.actions, newServices),
    });

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

    /** 初次引导：准备 session 后挂载装配面；关停期间不发布新的装配结果。 */
    const runAssembly = (loginResult: LoginResultLike, initial: boolean): Promise<boolean> =>
        assembly.mount(loginResult, () => prepareSession(loginResult, initial));

    /**
     * 软重登重装配（ready 态 control login 成功，relogin.ts 经 deps 调用）：
     * 先停旧装配面（协议消费方 → 缓存服务），再准备 session 并重跑装配链。
     * 失败返回 false（上报退出）。
     */
    const softRelogin = async (loginResult: LoginResultLike): Promise<boolean> => {
        sendStatus("sessioning");
        log(`bootstrap: 软重登 uin=${loginResult.uin}——清理旧装配并重跑装配链`);
        return await assembly.reassemble(loginResult, () => prepareSession(loginResult, false));
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
    // NAPUKETTO_QUICK_UIN 强制指定快速登录账号（cli `-q <uin>` 透传；
    // 也用于实验/自建宿主验证，防止自动选中风控账号 3054108135 导致挂起）。
    // NAPUKETTO_QR_ONLY 强制扫码：跳过快速登录直接 QR——
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
    // 或按相位忽略，见 relogin.ts 相位机——迟到结果不得误导上报）
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
