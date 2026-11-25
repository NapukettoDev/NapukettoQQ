/**
 * wrapper 生命周期编排：engine / session 的创建、初始化、启动与 boot 装配入口（原生装载在 loader.ts）。
 * wrapper.node 不是标准 NAPI self-register 模块，只能由 QQ 定制版 Electron 主进程的 preload 注册——
 * loader 注入 hook DLL 后截获 `process.dlopen` 的 exports；不用 koffi / vtable / 内存偏移，对象由 NAPI 构建。
 */
import process from "node:process";
import { getOwnProp, hasCallableProp, kernelError } from "../../infra/index.js";
import type {
    EnginInitDesktopConfig,
    NodeIKernelSessionListener,
    NodeIQQNTWrapperSession,
    NodeIQQNTWrapperSessionCtor,
    WrapperNodeApi,
    WrapperSessionInitConfig,
} from "../../types/index.js";
import {
    type BootEnv,
    defaultEngineConfig,
    electronProcessType,
    resolveBootQqGlobalPath,
} from "./loader.js";
import type { QqVersionContext, StartNapukettoOptions, WrapperContext } from "./types.js";
import {
    createSessionListener,
    DependsAdapter,
    DispatcherAdapter,
    GlobalAdapter,
} from "./wrapper-adapters.js";
import { isStartupSessionWrapper, isWrapperEngine, isWrapperSession } from "./wrapper-guards.js";

export type {
    QQVersionContext,
    QqVersionContext,
    StartNapukettoOptions,
    WrapperContext,
} from "./types.js";

/**
 * 从 loader 截获的 NAPI exports 创建 wrapper 上下文。
 * 在 QQ 主进程内调用（boot.cjs → kernel 入口）。
 */
export function createWrapper(
    exports: WrapperNodeApi,
    versionInfo: QqVersionContext,
): WrapperContext {
    const engineCtor = exports.NodeIQQNTWrapperEngine;
    if (!hasCallableProp(engineCtor, "get")) {
        throw kernelError(
            "wrapper.node exports 无效（缺少 NodeIQQNTWrapperEngine）",
            "INVALID_PARAM",
        );
    }
    const rawEngine = engineCtor.get();
    if (!isWrapperEngine(rawEngine)) {
        throw kernelError("NodeIQQNTWrapperEngine.get() 返回对象无效", "INVALID_PARAM");
    }
    const engine = rawEngine;
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
 * 创建会话：StartupSessionWrapper.create() → getNTWrapperSession("nt_1")（QQ 主 session，
 * 带完整 cpp_impl）→ S.create() 回退。
 *
 * ⚠️ `new NodeIQQNTWrapperSession()` 构造对象缺 cpp_impl，session.init 断言
 * "implementation of IQQNTWrapperSession is not valid"；必须走上两条路径拿带完整实现的
 * 实例。worker（utilityProcess）继承 QQ env 后同样有效。
 */
export function createSession(ctx: WrapperContext): NodeIQQNTWrapperSession {
    const S = ctx.exports.NodeIQQNTWrapperSession;
    const session =
        createStartupSession(ctx) ?? getNTWrapperSession(S) ?? createNewSession(S) ?? newSession(S);
    ctx.session = session;
    return session;
}

/**
 * 步骤 4：`new S()`（最后兜底）。
 *
 * isWrapperNodeApi 只保证「至少一个已知导出键存在」；Session 构造器可能缺失或
 * 被版本漂移换成非函数值（stub 半成品）。`new undefined()` 会抛裸 TypeError，
 * 这里换成 KernelError，且只在真正要 `new` 时才拒绝（静态方法可用的导出仍容忍）。
 */
function newSession(S: NodeIQQNTWrapperSessionCtor): NodeIQQNTWrapperSession {
    if (typeof S !== "function") {
        throw kernelError(
            "wrapper.node 导出缺少可调用的 NodeIQQNTWrapperSession 构造器",
            "INVALID_PARAM",
        );
    }
    return new S();
}

/** 步骤 1：StartupSessionWrapper.create()（建立启动 session，失败忽略）。 */
function createStartupSession(ctx: WrapperContext): NodeIQQNTWrapperSession | null {
    const sswCtor = ctx.exports.NodeIQQNTStartupSessionWrapper;
    if (!hasCallableProp(sswCtor, "create")) {
        return null;
    }
    try {
        const inst = sswCtor.create();
        if (isStartupSessionWrapper(inst)) {
            ctx.startupSession = inst;
        }
    } catch {
        // 可选，失败继续
    }
    return null;
}

/** 步骤 2：getNTWrapperSession("nt_1")（QQ 主 session，带 cpp_impl）。 */
function getNTWrapperSession(S: unknown): NodeIQQNTWrapperSession | null {
    if (!hasCallableProp(S, "getNTWrapperSession")) {
        return null;
    }
    try {
        const got = S.getNTWrapperSession("nt_1");
        return isWrapperSession(got) ? got : null;
    } catch {
        return null; // 回退
    }
}

/** 步骤 3：S.create() 回退（返回值同样过 session 方法面守卫，拒绝空壳对象）。 */
function createNewSession(S: NodeIQQNTWrapperSessionCtor): NodeIQQNTWrapperSession | null {
    const create = getOwnProp(S, "create");
    if (typeof create !== "function") {
        return null;
    }
    try {
        const created: unknown = Reflect.apply(create, S, []);
        return isWrapperSession(created) ? created : null;
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
    // isWrapperSession 只验 getMsgService（「service 挂载即 session 可用」），空壳
    // Session 能过守卫；init 是这里真正要调用的方法，缺失时给 KernelError 而非裸 TypeError。
    if (typeof getOwnProp(session, "init") !== "function") {
        throw kernelError(
            "session 实例缺少 init 方法（wrapper 版本不匹配或空壳 Session）",
            "INVALID_STATE",
        );
    }
    session.init(config, new DependsAdapter(), new DispatcherAdapter(), listener);
}

/**
 * 启动会话（有 startupSession 用 start()，否则 startNT(0)）。
 *
 * ⚠️ 单纯 start() 只在「已 init」的 session 上有效：先 start 后 init 业务 service 不挂载
 * （实测）。自建宿主必须先 session.init 再 startupSession.start()；本函数只用于给已 init
 * 的 session 补启动。
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
 * boot 装配入口：createWrapper → session → initEngine → loginService → O3MiscService。
 *
 * session 来源：qqSession（boot.cjs 拦截 `new` 窃取的 QQ 已 init session）优先，否则
 * createSession；getMainSession 实测为空壳（service 全 null + 缺 startNT），仅 probe 探测参考。
 * 由 kernel NapukettoCore（core.ts）装配调用；loader 自建宿主 bootstrap 也直接调用作回退。
 * 返回 WrapperContext；失败抛 KernelError。
 */
export function startNapuketto(options: StartNapukettoOptions): WrapperContext {
    const { env, engineConfig, sessionConfig, wrapperExports, qqSession, qqLoginService } = options;
    const versionInfo: QqVersionContext = {
        fullVersion: env?.qqVersion ?? "",
        buildVersion: env?.qqVersion ?? "",
    };
    const ctx = createWrapper(wrapperExports, versionInfo);
    const hasCapturedSession = captureSession(ctx, qqSession);
    // session 创建时机：**自建宿主（标准 node）必须在 engine init 之前创建**——SSW.create +
    // getNTWrapperSession("nt_1") 要在 engine.initWithDeskTopConfig 前；顺序反了则登录后
    // session.init 的 onOpentelemetryInit 不触发（自建宿主实测）。路线 B（utility）与
    // QQ 主进程（browser）保持 engine 先建的原顺序（已验证）。
    const isSelfHost = electronProcessType() === undefined;
    prepareSession(ctx, hasCapturedSession, isSelfHost);
    initEngine(ctx, resolveEngineConfig(ctx, env, engineConfig));
    resolveLoginService(ctx, qqLoginService);
    ctx.wrapperPath = env?.wrapperPath ?? process.env["NAPUKETTO_WRAPPER_PATH"];
    // 自建宿主必须激活 O3MiscService（三要素之二）：不激活则 getLoginList 永不
    // resolve（挂起）。放在装配入口自动执行，避免下游漏调 activateO3MiscService
    // 导致登录永久死锁；函数自身幂等（同一 exports 只激活一次）。
    if (isSelfHost) {
        activateO3MiscService(wrapperExports);
    }
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
    return defaultEngineConfig(env ?? {}, resolveBootQqGlobalPath(ctx.exports, env?.dataRoot));
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
 * 解析 loginService：优先捕获实例，其次单例 get()（自建宿主/worker 下 QQ 环境创建的
 * 实例才完整——`new` 自建实例读不到登录列表，getLoginList 为空），最后 new 回退。
 */
function resolveLoginService(ctx: WrapperContext, qqLoginService: unknown): void {
    if (qqLoginService !== undefined && qqLoginService !== null) {
        ctx.loginService = qqLoginService;
        return;
    }
    ctx.loginService = getOrCreateLoginService(ctx.exports);
}

/** 单例 get() 优先，缺失回退 new（都失败返回 null）。 */
function getOrCreateLoginService(exports: WrapperNodeApi): unknown {
    try {
        const loginSvcCtor = exports.NodeIKernelLoginService;
        if (hasCallableProp(loginSvcCtor, "get")) {
            return loginSvcCtor.get();
        }
        return new exports.NodeIKernelLoginService();
    } catch {
        return null;
    }
}

/** 已激活 O3MiscService 的 exports（幂等标记，避免重复挂监听）。 */
const ACTIVATED_O3_EXPORTS = new WeakSet<object>();

/**
 * 激活自建宿主 O3MiscService 事件分发（三要素之二）：不激活则 getLoginList 永不 resolve
 * （挂起）。listener 用普通对象（getOnAmgomDataPiece 空实现，wrapper 契约回调）。
 *
 * 幂等：同一 exports 重复调用只激活一次（已激活返回 true）。
 *
 * @param wrapperExports dlopen 产出的 exports（缺失/版本变化时返回 false）
 * @returns 是否成功激活
 */
export function activateO3MiscService(
    wrapperExports: WrapperNodeApi | Record<string, unknown> | undefined,
): boolean {
    if (wrapperExports === undefined || wrapperExports === null) {
        return false;
    }
    // 幂等：同一 exports 只激活一次（startNapuketto 自动激活 + 下游手动兜底不重复挂监听）。
    if (ACTIVATED_O3_EXPORTS.has(wrapperExports)) {
        return true;
    }
    const o3Ctor = wrapperExports["NodeIO3MiscService"];
    if (!hasCallableProp(o3Ctor, "get")) {
        return false;
    }
    const svc = o3Ctor.get();
    if (!hasCallableProp(svc, "addO3MiscListener")) {
        return false;
    }
    svc.addO3MiscListener({
        getOnAmgomDataPiece() {
            // 空实现：wrapper 契约回调，仅需注册存在即可激活事件分发
        },
    });
    ACTIVATED_O3_EXPORTS.add(wrapperExports);
    return true;
}
