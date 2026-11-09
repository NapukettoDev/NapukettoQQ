/**
 * wrapper 引导（NAPI 范式，2026-08-05 重构，替代旧 koffi 方案）
 *
 * 事实（实测）：wrapper.node 不是标准 NAPI self-register 模块，只能在 QQ 定制版
 * Electron 主进程里由 preload 注册。@napuketto/loader 注入 hook DLL 后，boot.cjs
 * 在 QQ 主进程内截获 `process.dlopen` 的 `module.exports`，然后调用本模块初始化。
 *
 * 本模块**不再**使用 koffi / vtable / 内存偏移——所有对象由 QQ 的 NAPI 层自动构建。
 * 业务层拿到的都是真实 JS 对象：engine.initWithDeskTopConfig(config, adapter) 等。
 */

import { homedir, version as osVersion } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { kernelError } from "../infra/index.js";
import type {
    EnginInitDesktopConfig,
    NodeIKernelSessionListener,
    NodeIQQNTStartupSessionWrapper,
    NodeIQQNTWrapperEngine,
    NodeIQQNTWrapperSession,
    NodeIQQNTWrapperSessionCtor,
    WrapperNodeApi,
    WrapperSessionInitConfig,
} from "../types/index.js";
import { PlatformType } from "../types/index.js";
import { extractDataRoot, resolveQqGlobalPath } from "./qq-data-path.js";
import {
    createSessionListener,
    DependsAdapter,
    DispatcherAdapter,
    GlobalAdapter,
} from "./wrapper-adapters.js";
import { buildQua, detectPlatformType, parseQuaFromMajor } from "./wrapper-config.js";

// ---------------------------------------------------------------
// startNapuketto 内部辅助（非 export，boot 装配用）
// ---------------------------------------------------------------

/**
 * 默认 engine 配置（按平台探测）。
 *
 * 平台：`process.platform` → KLINUX/KMAC/KWINDOWS；qua 优先从 wrapper.node 同目录
 * major.node 扫描（`NAPUTO_WRAPPER_PATH` 由 loader 注入），找不到再按版本拼。
 * Linux 实测需要 `V1_LNX_NQ_3.2.35_54395_GW_B`；Windows 旧行为（qua 空）仅在
 * 拿不到版本/major.node 时保底。
 */
function defaultEngineConfig(env: BootEnv, qqDataPath?: string): EnginInitDesktopConfig {
    const platform = detectPlatformType();
    const fullVersion = env.qqVersion ?? "";
    const wrapperPath = process.env["NAPUTO_WRAPPER_PATH"] ?? "";
    const majorPath = wrapperPath !== "" ? join(dirname(wrapperPath), "major.node") : "";
    const scanned = majorPath !== "" ? parseQuaFromMajor(majorPath) : null;
    const qua = scanned ?? (fullVersion !== "" ? buildQua(fullVersion, platform) : "");
    return {
        base_path_prefix: env.dataDir ?? "",
        platform_type: platform,
        app_type: 4,
        app_version: fullVersion,
        os_version: osVersion() || process.platform,
        use_xlog: platform !== PlatformType.KWINDOWS,
        qua,
        global_path_config: {
            desktopGlobalPath: qqDataPath ?? env.dataDir ?? "",
        },
        thumb_config: { maxSide: 324, minSide: 48, longLimit: 6, density: 2 },
    };
}

/**
 * Electron 进程类型（Node 的 process 类型无此字段）。
 * - "browser"：QQ 主进程（V1 模式）
 * - "utility"：utilityProcess Worker（路线 B，2026-08-06）
 */
export function electronProcessType(): string | undefined {
    return (process as unknown as { type?: string }).type;
}

/**
 * 解析 QQ 用户数据根（登录数据目录，如 `C:\Users\<user>\Documents\Tencent Files`）。
 * 优先 NodeQQNTWrapperUtil.getNTUserDataInfoConfig()（QQ 官方 API），回退默认位置。
 *
 * 背景（2026-08-06 P2-1 实测）：worker（utilityProcess）模式下 loginService 是
 * `new NodeIKernelLoginService()` 新建的，其 initConfig 的 commonPath 必须指向
 * QQ 真实数据路径才能读到历史账号——cli 的 `.napuketto\default` 数据目录读不到
 * （getLoginList 返回空 → 只能 QR 登录）。V1 主进程模式 QQ 自己 initConfig 过
 * 正确路径，无需此解析。
 */
export function resolveQqUserDataRoot(exports: WrapperNodeApi): string | null {
    return extractUserDataRoot(exports) ?? join(homedir(), "Documents", "Tencent Files");
}

/** 从 QQ 官方 API 提取数据根（不可用返回 null，调用方回退默认）。 */
function extractUserDataRoot(exports: WrapperNodeApi): string | null {
    try {
        const util = exports.NodeQQNTWrapperUtil as unknown as {
            get?: () => { getNTUserDataInfoConfig?: () => unknown };
        } | null;
        const raw = util?.get?.().getNTUserDataInfoConfig?.();
        if (typeof raw === "string" && raw.trim() !== "") {
            return extractDataRoot(raw.trim());
        }
    } catch {
        // 回退默认位置
    }
    return null;
}

// ---------------------------------------------------------------
// 导出区（useExportsLast：export 全部在文件末尾）
// ---------------------------------------------------------------

/** QQ 版本信息（登录握手用）。 */
export interface QQVersionContext {
    fullVersion: string;
    buildVersion: string;
}

/** 已引导的 wrapper 上下文（运行在 QQ Electron 主进程内）。 */
export interface WrapperContext {
    /** wrapper.node 的 NAPI 顶层导出。 */
    exports: WrapperNodeApi;
    /** engine 单例（get() 已调用）。 */
    engine: NodeIQQNTWrapperEngine;
    /** 版本信息（供登录握手等使用）。 */
    versionInfo: QQVersionContext;
    /** 会话（QQ 拦截捕获 / createSession 后填充）。 */
    session: NodeIQQNTWrapperSession | null;
    /** 启动会话包装（NapCat 同款：StartupSessionWrapper.create()，start() 替代 startNT）。 */
    startupSession: NodeIQQNTStartupSessionWrapper | null;
    /** QQ 的 loginService 实例（拦截 new 捕获，可为 null）。 */
    loginService: unknown;
}

/**
 * 从 loader 截获的 NAPI exports 创建 wrapper 上下文。
 * 在 QQ 主进程内调用（boot.cjs → kernel 入口）。
 */
export function createWrapper(
    exports: WrapperNodeApi,
    versionInfo: QQVersionContext,
): WrapperContext {
    const engineMaybe = exports.NodeIQQNTWrapperEngine as unknown as {
        get?: () => NodeIQQNTWrapperEngine;
    } | null;
    if (engineMaybe === null || typeof engineMaybe.get !== "function") {
        throw kernelError(
            "wrapper.node exports 无效（缺少 NodeIQQNTWrapperEngine）",
            "INVALID_PARAM",
        );
    }
    const engine = engineMaybe.get();
    if (!engine || typeof engine.initWithDeskTopConfig !== "function") {
        throw kernelError("NodeIQQNTWrapperEngine.get() 返回对象无效", "INVALID_PARAM");
    }
    return {
        exports,
        engine,
        versionInfo,
        session: null,
        startupSession: null,
        loginService: null,
    };
}

/** engine 初始化（wrapper 契约：先 engine 后 session）。config 为普通 JS 对象。 */
export function initEngine(ctx: WrapperContext, config: EnginInitDesktopConfig): void {
    ctx.engine.initWithDeskTopConfig(config, new GlobalAdapter());
}

/**
 * 创建会话（2026-08-06 P2-0 实测修正——NapCat 方式自研等价）：
 *  1. StartupSessionWrapper.create()（启动会话包装）
 *  2. getNTWrapperSession("nt_1")（QQ 主 session，带完整 cpp_impl）
 *  3. S.create() 回退
 *
 * 背景：`new NodeIQQNTWrapperSession()` 构造对象缺 cpp_impl，session.init 断言
 * "implementation of IQQNTWrapperSession is not valid"（P2-0 实测确认）。
 * NapCat 用 StartupSessionWrapper.create() + getNTWrapperSession('nt_1') 解决——
 * 返回带完整实现的实例。worker（utilityProcess）继承 QQ env 后同样有效。
 */
export function createSession(ctx: WrapperContext): NodeIQQNTWrapperSession {
    const S = ctx.exports.NodeIQQNTWrapperSession;
    const session =
        createStartupSession(ctx) ?? getNTWrapperSession(S) ?? createNewSession(S) ?? new S();
    ctx.session = session;
    return session;
}

/** 步骤 1：StartupSessionWrapper.create()（建立启动 session，失败忽略）。 */
function createStartupSession(ctx: WrapperContext): NodeIQQNTWrapperSession | null {
    const Ssw = ctx.exports.NodeIQQNTStartupSessionWrapper as unknown as
        | {
              create?: () => NodeIQQNTStartupSessionWrapper;
          }
        | undefined;
    if (Ssw === undefined || typeof Ssw.create !== "function") {
        return null;
    }
    try {
        ctx.startupSession = Ssw.create();
    } catch {
        // 可选，失败继续
    }
    return null;
}

/** 步骤 2：getNTWrapperSession("nt_1")（QQ 主 session，带 cpp_impl）。 */
function getNTWrapperSession(S: NodeIQQNTWrapperSessionCtor): NodeIQQNTWrapperSession | null {
    if (typeof S.getNTWrapperSession !== "function") {
        return null;
    }
    try {
        return S.getNTWrapperSession("nt_1");
    } catch {
        return null; // 回退
    }
}

/** 步骤 3：S.create() 回退。 */
function createNewSession(S: NodeIQQNTWrapperSessionCtor): NodeIQQNTWrapperSession | null {
    if (typeof S.create !== "function") {
        return null;
    }
    try {
        return S.create();
    } catch {
        return null;
    }
}

/** session 初始化（4 参全为 JS 对象，NAPI 自动转换）。 */
export function initSession(
    ctx: WrapperContext,
    config: WrapperSessionInitConfig,
    listener: NodeIKernelSessionListener,
): void {
    const session = ctx.session ?? createSession(ctx);
    session.init(config, new DependsAdapter(), new DispatcherAdapter(), listener);
}

/**
 * 启动会话（有 startupSession 用 start()，否则 startNT(0)）。
 *
 * ⚠️ 2026-08-07 V9 修正：单纯 start() 只在「已 init」的 session 上有效。
 * 自建宿主必须走 initAndStartSession（先 session.init 再 startupSession.start()）——
 * 先 start 后 init 业务 service 不挂载（HANDOVER-V9 实测）。本函数保留给
 * 已 init 的 session 补启动用；新路径请用 initAndStartSession。
 */
export function startSession(ctx: WrapperContext): void {
    const { session, startupSession } = ctx;
    if (session === null) {
        throw kernelError("session 未创建，无法启动", "INVALID_STATE");
    }
    if (startupSession !== null && typeof startupSession.start === "function") {
        startupSession.start();
        return;
    }
    session.startNT(0);
}

/**
 * boot 装配入口：createWrapper → initEngine → session。
 *
 * **session 来源（2026-08-05 修正）**：
 *  1. qqSession（boot.cjs 拦截 `new` 窃取的 QQ 已 init session）——尚未落地
 *  2. createSession（`new NodeIQQNTWrapperSession()`）——实测可用，默认路径
 *  （getMainSession 实测为空壳：service 全 null + 缺 startNT，仅 probe 探测参考）
 *
 * 由 kernel NapukettoCore（core.ts）装配调用；loader 自建宿主 bootstrap 也直接调用作回退。
 * 返回 WrapperContext；失败抛 KernelError。
 */
export function startNapuketto(options: StartNapukettoOptions): WrapperContext {
    const { env, engineConfig, sessionConfig, wrapperExports, qqSession, qqLoginService } = options;
    const versionInfo: QQVersionContext = {
        fullVersion: env?.qqVersion ?? "",
        buildVersion: env?.qqVersion ?? "",
    };
    const ctx = createWrapper(wrapperExports, versionInfo);
    const hasCapturedSession = captureSession(ctx, qqSession);
    // session 创建时机：**自建宿主（标准 node）必须在 engine init 之前创建**——
    // p0-kernel-flow 决定性顺序（HANDOVER-V6）：SSW.create + getNTWrapperSession("nt_1")
    // 在 engine.initWithDeskTopConfig 前；engine 先建 session 后建 → 登录后
    // session.init 的 onOpentelemetryInit 不触发（2026-08-07 自建宿主实测）。
    // 路线 B（utility）与 QQ 主进程（browser）保持 engine 先建原顺序（已验证）。
    const isSelfHost = electronProcessType() === undefined;
    prepareSession(ctx, hasCapturedSession, isSelfHost);
    initEngine(ctx, resolveEngineConfig(ctx, env, engineConfig));
    resolveLoginService(ctx, qqLoginService);
    // session：路线 B（utility）与 QQ 主进程（browser）在 engine 后创建；
    // 自建宿主已在 engine 前创建（isSelfHost 分支），此处跳过避免重复。
    finishSession(ctx, hasCapturedSession, isSelfHost, sessionConfig);
    return ctx;
}

/** engine 前 session 准备（自建宿主必须先建，顺序决定性）。 */
function prepareSession(ctx: WrapperContext, hasCaptured: boolean, isSelfHost: boolean): void {
    if (!hasCaptured && isSelfHost) {
        createSession(ctx);
    }
}

/** engine 后收尾：非自建宿主补建 session；配置了 sessionConfig 则 init+start。 */
function finishSession(
    ctx: WrapperContext,
    hasCaptured: boolean,
    isSelfHost: boolean,
    sessionConfig: WrapperSessionInitConfig | undefined,
): void {
    if (!hasCaptured && !isSelfHost) {
        createSession(ctx);
    }
    if (sessionConfig !== undefined) {
        initSession(ctx, sessionConfig, createSessionListener());
        startSession(ctx);
    }
}

/** engine 配置：显式覆盖优先，否则默认（含 QQ 数据根 global 路径解析）。 */
function resolveEngineConfig(
    ctx: WrapperContext,
    env: BootEnv | undefined,
    engineConfig: EnginInitDesktopConfig | undefined,
): EnginInitDesktopConfig {
    if (engineConfig !== undefined) {
        return engineConfig;
    }
    return defaultEngineConfig(env ?? {}, resolveBootQqGlobalPath(ctx));
}

/** 捕获 QQ 已 init 的 session（boot.cjs 拦截 `new` 窃取），返回是否捕获成功。 */
function captureSession(
    ctx: WrapperContext,
    qqSession: NodeIQQNTWrapperSession | null | undefined,
): boolean {
    if (qqSession === undefined || qqSession === null) {
        return false;
    }
    ctx.session = qqSession;
    return true;
}

/**
 * 解析 QQ 真实数据目录的 global 路径（desktopGlobalPath 三要素之三）。
 * worker（utilityProcess）模式 + 自建宿主（标准 node）下必须指向 QQ 真实
 * 数据目录（数据根/nt_qq/global，HANDOVER-V6），否则登录数据读写错位
 * （P2-1 实测 2026-08-06；getLoginList 空）。QQ 主进程（V1）QQ 自己已配置
 * engine，无需解析。
 */
function resolveBootQqGlobalPath(ctx: WrapperContext): string | undefined {
    if (electronProcessType() === "browser") {
        return undefined;
    }
    const root = resolveQqUserDataRoot(ctx.exports);
    if (root === null) {
        return undefined;
    }
    return resolveQqGlobalPath(root);
}

/**
 * 解析 loginService：优先捕获实例，其次单例 get()（自建宿主/worker 下 QQ 环境
 * 创建的实例才完整——`new` 自建实例读不到登录列表（getLoginList 空），
 * HANDOVER-V6 p0-login3 实证），最后 new 回退。
 */
function resolveLoginService(ctx: WrapperContext, qqLoginService: unknown): void {
    if (qqLoginService !== undefined && qqLoginService !== null) {
        ctx.loginService = qqLoginService as WrapperContext["loginService"];
        return;
    }
    ctx.loginService = getOrCreateLoginService(ctx.exports);
}

/** 单例 get() 优先，缺失回退 new（都失败返回 null）。 */
function getOrCreateLoginService(exports: WrapperNodeApi): unknown {
    try {
        const loginSvcCtor = exports.NodeIKernelLoginService as unknown as {
            get?: () => unknown;
        } | null;
        if (loginSvcCtor !== null && typeof loginSvcCtor.get === "function") {
            return loginSvcCtor.get();
        }
        return new exports.NodeIKernelLoginService();
    } catch {
        return null;
    }
}

/** startNapuketto 的引导环境（由 loader launcher 注入环境变量，boot.cjs 透传）。 */
export interface BootEnv {
    /** QQ 版本（如 "9.9.31-49919"）。 */
    qqVersion?: string;
    /** 用户数据目录（cfgDir 的父级，用于 desktopPathConfig）。 */
    dataDir?: string;
    /** 账号 uin（可选，提供则一步 init+start）。 */
    selfUin?: string;
    /** 账号 uid（可选）。 */
    selfUid?: string;
}

/** startNapuketto 选项。 */
export interface StartNapukettoOptions {
    /** 截获的 wrapper.node NAPI exports（boot.cjs 传入）。 */
    wrapperExports: WrapperNodeApi;
    /** 引导环境（版本/数据目录/账号）。 */
    env?: BootEnv;
    /** 覆盖 engine 配置（联调用）。 */
    engineConfig?: EnginInitDesktopConfig;
    /** 覆盖 session 配置（联调用，提供则自动 init+start）。 */
    sessionConfig?: WrapperSessionInitConfig;
    /** QQ 已 init 的 session（boot.cjs 拦截 new 捕获）。 */
    qqSession?: NodeIQQNTWrapperSession | null;
    /** QQ 的 loginService 实例（boot.cjs 拦截 new 捕获）。 */
    qqLoginService?: unknown;
}
