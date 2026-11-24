/**
 * bootstrap.ts：kernel 引导核心（import kernel → 装配 → 登录 → session 替换 → 协议装配）。
 * 2026-08-07 阶段 2：由 runtime/boot-bootstrap.js TS 化（零语义改动）。
 * 由 self-host.ts（自建宿主，2026-08-07 唯一路线）在 dlopen wrapper.node 后调用。
 *
 * 2026-08-07 阶段 1 拆分（零语义改动）：
 *  - 登录流程（选账号 / 快速登录 / QR 回退）→ login.ts
 *  - session 选择 / 探测 / 就绪 → session.ts
 *  - 协议装配 → protocols.ts；冒烟自检 → smoke.ts
 * 2026-08-08 FTA 优化：NapukettoCore 装配路径 → bootstrap-core.ts（本文件留入口 + fallback）。
 *
 * session 来源（2026-08-07 实测结论；V1 Proxy 捕获与 vehicle 载具已归档 archive/）：
 *  登录成功后按优先级取 session：
 *    ① kernel.getMainSession(ctx)（startup 链路 getNTWrapperSession(nt_x)——QQ 主 session，
 *      渲染进程已完成 init → getMsgService READY）
 *    ② get() / qqSession（V1 兼容）
 *  取到后 core.setSession 替换 → waitSessionReady 确认 getMsgService READY。
 */
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { isShuttingDown } from "../../lifecycle/shutdown.js";
import { env, isEnvEnabled } from "../env.js";
import { type IpcServerOptions, sendStatus } from "../ipc/index.js";
import { getOwnProp, hasCallableProp } from "../type-guards.js";
import type { CoreContextLike, KernelLike, LoginResultLike } from "../types.js";
import { convergeBootstrapFailure, errMsg, log, type SharedState } from "../util.js";
import { type BootstrapEnv, bootstrapWithCore, probeOnce } from "./bootstrap-core.js";
import { isKernelModule } from "./module-guards.js";

/** ⭐ appid 动态解析（2026-08-06 P2-0 实测：硬编码 537237765 在 9.9.33 扫码失败
 * 「请下载最新版」；major.node 解析的 537376818 成功）。自研，参考 NapCat 思路。
 * 2026-08 硬编码审计：删除第三层字面量兜底 537237765——解析失败复用 kernel 的
 * resolveAppidQua（已改为失败抛 KernelError），旧 kernel 则显式抛错，不再静默回退。 */
function resolveAppid(kernel: KernelLike, bootEnv: BootstrapEnv): string | number {
    const majorPath = bootEnv.wrapperPath
        ? join(dirname(bootEnv.wrapperPath), "major.node")
        : undefined;
    if (typeof kernel.resolveAppidQua === "function") {
        return kernel.resolveAppidQua(bootEnv.qqVersion || "", majorPath).appid;
    }
    if (typeof kernel.parseAppidFromMajor === "function" && majorPath !== undefined) {
        const appid = kernel.parseAppidFromMajor(majorPath);
        if (appid !== null) {
            return appid;
        }
    }
    throw new Error(
        "无法从 major.node 解析 appid，请确认 wrapper.node/major.node 完整，或更新 qq-releases.json",
    );
}

/** kernel 生命周期能力（quickLogin 可用；initAndStartSession 本就必选）。
 * 类型谓词：guard 之后直接调用 quickLogin 不需再判空。 */
interface LifecycleKernel extends KernelLike {
    quickLogin: NonNullable<KernelLike["quickLogin"]>;
}

/** kernel 生命周期能力探测（quickLogin / initAndStartSession 是否可用）。 */
function hasLifecycleFns(kernel: KernelLike): kernel is LifecycleKernel {
    return (
        typeof kernel.quickLogin === "function" && typeof kernel.initAndStartSession === "function"
    );
}

/** 登录前置：loginConfig 构建并 initConfig（kernel/ctx 能力缺失时跳过，不阻塞登录）。 */
function initLoginConfig(
    kernel: KernelLike,
    ctx: CoreContextLike,
    Appid: string | number,
    qqVersion: string,
    dataDir: string,
): void {
    const loginService = ctx.loginService;
    if (typeof kernel.buildLoginConfig !== "function" || !loginService) {
        return;
    }
    const loginCfg = kernel.buildLoginConfig(Appid, qqVersion, dataDir);
    if (hasCallableProp(loginService, "initConfig")) {
        loginService.initConfig(loginCfg);
        log("bootstrap: loginService.initConfig OK");
    }
}

/** NT session 配置构建 + initAndStartSession（登录成功后拉起 session）。 */
async function buildAndStartSession(
    kernel: KernelLike,
    ctx: CoreContextLike,
    loginResult: LoginResultLike,
    Appid: string | number,
    qqVersion: string,
    dataDir: string,
): Promise<void> {
    // 设备指纹 guid：loginService.getMachineGuid()（kernel 原生反射，反风控）。
    const machineGuid =
        typeof kernel.readMachineGuid === "function"
            ? kernel.readMachineGuid(ctx.loginService)
            : "";
    const sessionConfig = kernel.buildSessionConfig({
        appid: Appid,
        fullVersion: qqVersion,
        selfUin: loginResult.uin,
        selfUid: loginResult.uid,
        accountPath: dataDir,
        downloadPath: join(dataDir, "temp"),
        machineGuid,
    });
    const listener = kernel.createLifecycleSessionListener();
    await kernel.initAndStartSession(ctx, sessionConfig, listener, {
        timeoutMs: 20000,
    });
}

/** 快速登录 + session 初始化（kernel lifecycle 路径）。生命周期方法缺失 → false（无登录态，引导不完整）。 */
async function quickLoginAndStartSession(
    kernel: KernelLike,
    ctx: CoreContextLike,
    Appid: string | number,
    bootEnv: BootstrapEnv,
): Promise<boolean> {
    if (!hasLifecycleFns(kernel)) {
        log("bootstrap: kernel missing lifecycle fns (quickLogin/initAndStartSession)");
        return false;
    }
    const dataDir = bootEnv.dataDir || ".";
    initLoginConfig(kernel, ctx, Appid, bootEnv.qqVersion, dataDir);
    const loginResult = await kernel.quickLogin(ctx, {});
    log(`bootstrap: quickLogin OK, uin=${loginResult.uin}, uid=${loginResult.uid}`);
    await buildAndStartSession(kernel, ctx, loginResult, Appid, bootEnv.qqVersion, dataDir);
    log("bootstrap: session init + startNT OK!");
    return true;
}

/** 回退：旧装配路径（startNapuketto + 手工 lifecycle）。返回引导是否完整完成。 */
async function bootstrapFallback(
    kernel: KernelLike,
    state: SharedState,
    bootEnv: BootstrapEnv,
    Appid: string | number,
): Promise<boolean> {
    // 回退：旧装配路径（startNapuketto + 手工 lifecycle）
    log("bootstrap: kernel has no NapukettoCore, falling back");
    const ctx: CoreContextLike | undefined = kernel.startNapuketto?.({
        wrapperExports: state.wrapperExports,
        env: { ...bootEnv },
    });
    if (ctx === undefined) {
        log("bootstrap: startNapuketto 不可用");
        return false;
    }
    log(
        `bootstrap: startNapuketto OK, engine=${typeof ctx.engine}, session=${ctx.session !== null}`,
    );
    const loggedIn = await quickLoginAndStartSession(kernel, ctx, Appid, bootEnv);
    probeOnce(kernel, ctx);
    return loggedIn;
}

/** kernel 入口能力探测（startNapuketto / NapukettoCore 任一装配入口即可）。 */
function hasAssemblyEntry(kernel: KernelLike): boolean {
    return (
        typeof kernel.startNapuketto === "function" || typeof kernel.NapukettoCore === "function"
    );
}

/** 动态 import kernel 入口（未注入 / 导入失败 / 无装配入口 → undefined，调用方收敛 false）。 */
async function importKernel(): Promise<KernelLike | undefined> {
    const kernelEntry = env.NAPUKETTO_KERNEL_ENTRY;
    if (!kernelEntry) {
        log("bootstrap: NAPUKETTO_KERNEL_ENTRY not set");
        return undefined;
    }
    const rawKernel: unknown = await import(pathToFileURL(kernelEntry).href);
    if (!isKernelModule(rawKernel)) {
        throw new Error(`Invalid @napuketto/kernel module exports at ${kernelEntry}`);
    }
    const kernel = rawKernel;
    log(`bootstrap: kernel imported, keys: ${Object.keys(kernel).join(", ")}`);
    if (!hasAssemblyEntry(kernel)) {
        log("bootstrap: kernel 无 startNapuketto/NapukettoCore 导出");
        return undefined;
    }
    return kernel;
}

/** bootEnv 归一化（env 快照 string | undefined → string）。 */
function buildBootEnv(): BootstrapEnv {
    return {
        qqVersion: env.NAPUKETTO_QQ_VERSION || "",
        dataDir: env.NAPUKETTO_CFG_DIR || "",
        dataRoot: env.NAPUKETTO_DATA_ROOT || "",
        wrapperPath: env.NAPUKETTO_WRAPPER_PATH || "",
    };
}

/** appid 解析 + 装配路径分发（NapukettoCore 走 core 装配，否则旧 fallback 路径）。 */
async function dispatchAssembly(
    kernel: KernelLike,
    state: SharedState,
    bootEnv: BootstrapEnv,
    ipc?: IpcServerOptions,
): Promise<boolean> {
    try {
        // resolveAppid 失败会抛错（major.node 缺失/解析失败）——显式报错，不再静默回退。
        const Appid = resolveAppid(kernel, bootEnv);
        log(`bootstrap: appid=${Appid}（wrapper=${bootEnv.wrapperPath}）`);
        if (kernel.NapukettoCore !== undefined) {
            return await bootstrapWithCore(kernel, state, bootEnv, Appid, ipc);
        }
        if (ipc !== undefined) {
            log("bootstrap: IPC 要求 kernel NapukettoCore");
            return false;
        }
        return await bootstrapFallback(kernel, state, bootEnv, Appid);
    } catch (e) {
        return convergeBootstrapFailure(e, "lifecycle error");
    }
}

function loadHostWrapper(kernel: KernelLike, path: string): Record<string, unknown> {
    if (typeof kernel.dlopenWrapper !== "function") {
        throw new Error("kernel 缺少 dlopenWrapper，需要 @napuketto/kernel >= 0.12.3");
    }
    try {
        const exports = kernel.dlopenWrapper(path);
        kernel.activateO3MiscService?.(exports);
        return exports;
    } catch (err) {
        const code = getOwnProp(err, "code") === "INVALID_STATE" ? "INVALID_STATE" : "UNKNOWN";
        if (isEnvEnabled(env.NAPUKETTO_IPC)) {
            sendStatus("failed", "原生引导失败", { code, message: errMsg(err) });
        }
        throw err;
    }
}

/**
 * 核心引导：import kernel → 装配 → 登录 → 替换 session → 等待就绪 → 协议装配。
 * @returns 引导是否完整完成（IPC 模式 = 协议服务装配成功；各失败路径静默收敛为
 *   false 而非抛错，具体原因记录在 NAPUKETTO_CFG_DIR 下 napuketto-boot.log——
 *   调用方 self-host 依此决定 ready/failed 与进程去留）。唯一例外：配置校验
 *   失败（ConfigError 契约）重抛，self-host 以 78 区分配置未就绪与运行时崩溃。
 */
export async function bootstrap(state: SharedState, ipc?: IpcServerOptions): Promise<boolean> {
    try {
        const kernel = await importKernel();
        if (kernel === undefined || isShuttingDown()) {
            return false;
        }
        const bootEnv = buildBootEnv();
        if (state.wrapperExports === null) {
            if (isEnvEnabled(env.NAPUKETTO_IPC)) {
                sendStatus("dlopening");
            }
            state.wrapperExports = loadHostWrapper(kernel, bootEnv.wrapperPath);
        }
        return await dispatchAssembly(kernel, state, bootEnv, ipc);
    } catch (e) {
        return convergeBootstrapFailure(e, "kernel 引导失败");
    }
}
