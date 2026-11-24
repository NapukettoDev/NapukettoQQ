/**
 * NapukettoCore：装配 + 启动（§9 第 6 项，2026-08-05 实现）
 *
 * 装配：paths（建目录）→ logger → CoreContext。
 * 启动：attachWrapper（wrapperExports → startNapuketto）→ login（快速登录 → session.init）。
 *
 * 典型用法（boot.cjs 截获 exports 后）：
 *   const core = await NapukettoCore.create({ dataRoot, account });
 *   core.attachWrapper(wrapperExports, { qqVersion, dataDir });
 *   // appid 由 resolveAppidQua 从 major.node 动态解析（版本绑定，不写死）
 *   await core.login({ appid });
 *
 * 与手动拼 startNapuketto/quickLogin/initAndStartSession 等价，但把装配状态
 * （ctx）集中管理，协议层直接消费 core.ctx。
 */

import { chmodSync, lstatSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { type CoreContext, createCoreContext } from "./context.js";
import {
    createLogger,
    kernelError,
    type LogFormat,
    type LogLevel,
    type PathOptions,
    PathWrapper,
    type TimestampMode,
} from "./infra/index.js";
import {
    initAndStartSession,
    type LoginResult,
    type LoginState,
    type QrCodeData,
    QrLoginSession,
    type QuickLoginOptions,
    quickLogin,
    type SelfInfo,
    waitSessionReady,
} from "./login/index.js";
import type { KernelRuntime, KernelRuntimeOptions } from "./runtime.js";
import { createKernelRuntime } from "./runtime.js";
import type { NodeIQQNTWrapperSession, WrapperNodeApi } from "./types/index.js";
import { isRecord } from "./utils/type-guards.js";
import { resolveQqGlobalPath } from "./wrapper/qq-data-path.js";
import { createSessionListener } from "./wrapper/wrapper-adapters.js";
import {
    buildLoginConfig,
    buildSessionConfig,
    readMachineGuid,
    resolveAppidQua,
} from "./wrapper/wrapper-config.js";
import {
    type BootEnv,
    electronProcessType,
    resolveQqUserDataRoot,
    startNapuketto,
    type WrapperContext,
} from "./wrapper/wrapper-loader.js";

export interface NapukettoCoreOptions {
    /** 数据根 / 账号（透传给 PathWrapper，见 ADR-016）。 */
    paths?: PathOptions | undefined;
    /** 日志级别，默认 info。 */
    logLevel?: LogLevel | undefined;
    /** 文件日志路径；不传则默认 `logs/napuketto.log`（父目录自动创建）。 */
    logFile?: string | undefined;
    /** 文件目的地级别（可低于控制台级别；缺省同 logLevel）。 */
    logFileLevel?: LogLevel | undefined;
    /** 是否输出 console，默认 true。 */
    consoleLog?: boolean | undefined;
    /** 控制台格式（缺省按 TTY 自动：TTY pretty / pipe single-line）。 */
    logFormat?: LogFormat | undefined;
    /** 时间戳渲染模式，默认 local。 */
    logTimestamp?: TimestampMode | undefined;
    /** 控制台颜色（缺省自动）。 */
    logColorize?: boolean | undefined;
    /** 账号标注（记录结构化 account 字段；快速登录目标账号，登录前已知时传入）。 */
    account?: string | undefined;
}

/**
 * 登录进度（IPC 子进程模式经 onLoginProgress 转发；koishi 插件展示二维码/状态用）。
 *
 * 可辨识联合：`state` 是判别字段，`switch (progress.state)` 后 `qr` / `selfInfo` /
 * `message` 由编译器自然收窄（waiting_scan 必有 qr、logged_in 必有 selfInfo、
 * failed 必有 message）。属性名与旧版完全一致，下游 `progress.qr` 等访问路径不变。
 */
export type LoginProgress =
    | { state: "idle"; qr?: undefined; selfInfo?: undefined; message?: string | undefined }
    | {
          state: "waiting_scan";
          qr: QrCodeData;
          selfInfo?: undefined;
          message?: string | undefined;
      }
    | {
          state: "scanned";
          qr?: QrCodeData | undefined;
          selfInfo?: undefined;
          message?: string | undefined;
      }
    | { state: "logged_in"; qr?: undefined; selfInfo: SelfInfo; message?: string | undefined }
    | { state: "failed"; qr?: undefined; selfInfo?: undefined; message: string };

/** login 参数。 */
export interface CoreLoginOptions {
    /**
     * appid（登录握手）。**可选**：未传时自动从 wrapperPath 同目录 major.node
     * 解析（`resolveAppidQua`）；wrapperPath 缺省回退 `NAPUKETTO_WRAPPER_PATH` /
     * `NAPUKETTO_WRAPPER_PATH` 环境变量。仍无法解析则抛 INVALID_PARAM。
     */
    appid?: string | undefined;
    /** session.init 超时（毫秒），默认 15s。 */
    initTimeoutMs?: number | undefined;
    /** 指定快速登录账号（缺省遍历历史列表）。 */
    quickUin?: string | undefined;
    /**
     * 单步快速登录超时（毫秒，T3 软重登挂起兜底），默认 20s。服务端已有同账号
     * 会话时底层 quickLoginWithUin/getLoginList 永久挂起，超时按登录失败抛出
     * （qrFallback 可接）。底层 promise 无法取消：超时后悬挂丢弃。
     */
    quickLoginTimeoutMs?: number | undefined;
    /** 快速登录失败时回退 QR 登录（二维码写账号 cache/qr 临时目录），默认 false。 */
    qrFallback?: boolean | undefined;
    /** 强制扫码：跳过快速登录，直接走 QR 登录（koishi 强制扫码 / 切账号）。默认 false。 */
    qrOnly?: boolean | undefined;
    /**
     * QR 二维码图片保存路径（显式指定时由调用方接管生命周期；默认
     * `<账号目录>/cache/qr/qrcode.png`，登录结束删除）。
     */
    qrCodePath?: string | undefined;
    /** 登录进度回调（QR 阶段：二维码数据 + 状态变化）。子进程 IPC 模式转发用。 */
    onLoginProgress?: ((progress: LoginProgress) => void) | undefined;
    /**
     * 登录成功后自动完成 Session 激活闭环（accountPath → machineGuid →
     * buildSessionConfig → initAndStartSession → waitSessionReady）。
     * 默认 false：保持 loader 现有「手动 activateSession」流程 100% 兼容。
     */
    activateSession?: boolean | undefined;
}

/**
 * 核心装配器：持有 CoreContext，负责启动/停止编排。
 * 无全局单例（ADR-015 推论）——每账号每进程实例化一份。
 */
export class NapukettoCore {
    /** 装配根（协议层 / apis / cache 的消费入口）。 */
    readonly ctx: CoreContext;

    /** QR 登录会话句柄（登录期间非空；登录终态后清空）。refreshQr() 据此可达。 */
    private qrSession: QrLoginSession | null = null;

    /** 本次登录默认落盘的临时二维码路径（显式 qrCodePath 不纳入自动清理）。 */
    private ephemeralQrCodePath: string | null = null;

    /** 由 createRuntime() 装配的运行时服务集合（stop/dispose 时统一清理）。 */
    private runtime: KernelRuntime | null = null;

    /** stop 幂等标记。 */
    private stopped = false;

    /** 由 create() 装配，不直接 new。 */
    private constructor(ctx: CoreContext) {
        this.ctx = ctx;
    }

    /**
     * 装配：paths（建目录）→ logger → CoreContext。
     * 不加载 wrapper / 不登录——启动阶段由 attachWrapper + login 完成。
     */
    static create(opts: NapukettoCoreOptions = {}): NapukettoCore {
        const paths = new PathWrapper(opts.paths);
        paths.ensure();
        // base.name 用 pino 保留字段（logger name）：pretty 渲染为 (kernel/pid)
        // 元数据头，不占属性行；cli/loader 同款，三来源可区分。account 未知时
        // 序列化层自然丢弃 undefined，无需条件展开。
        const logger = createLogger({
            level: opts.logLevel ?? "info",
            console: opts.consoleLog ?? true,
            file: opts.logFile ?? paths.file("logs", "napuketto.log"),
            fileLevel: opts.logFileLevel,
            format: opts.logFormat,
            timestamp: opts.logTimestamp,
            colorize: opts.logColorize,
            base: { name: "kernel", account: opts.account },
        });
        return new NapukettoCore(createCoreContext({ logger, paths }));
    }

    /**
     * 装配 wrapper：wrapperExports → startNapuketto（engine.init + session 创建），
     * 结果挂到 ctx.wrapper。在 QQ 主进程内调用（boot.cjs 截获 exports 后）。
     * captured：boot.cjs 拦截 `new` 捕获的 QQ 实例（session/loginService，优先使用）。
     */
    attachWrapper(
        wrapperExports: WrapperNodeApi,
        env?: BootEnv,
        captured?: { qqSession?: NodeIQQNTWrapperSession | null; qqLoginService?: unknown },
    ): WrapperContext {
        let wrapper: WrapperContext;
        if (env === undefined) {
            wrapper = startNapuketto({ wrapperExports, ...captured });
        } else {
            wrapper = startNapuketto({ wrapperExports, env, ...captured });
        }
        this.ctx.wrapper = wrapper;
        this.ctx.logger.info({ version: env?.qqVersion }, "wrapper 装配完成（engine + session）");
        return wrapper;
    }

    /**
     * 登录握手（wrapper 契约，2026-08-05 实测确认）：
     * loginService.initConfig → 登录（快速/QR）→ 填 ctx.login 后返回。
     *
     * 默认**仅完成登录握手**，不做 session 初始化——QQ 登录后重建 session
     * （boot.cjs Proxy 捕获新实例并 setSession 替换），替换发生在 login 返回之后。
     * 需要一步完成会话初始化时：传 `activateSession: true`（登录成功后自动跑
     * accountPath → machineGuid → buildSessionConfig → initAndStartSession →
     * waitSessionReady），或随后手动调用 `core.activateSession()`。
     */
    async login(opts: CoreLoginOptions): Promise<LoginResult> {
        const { wrapper } = this.ctx;
        if (wrapper === null) {
            throw kernelError("wrapper 未装配，无法登录", "INVALID_STATE");
        }
        const appid = resolveCoreAppid(wrapper, opts.appid);

        // 1. loginService.initConfig（wrapper 流程：addKernelLoginListener 前）
        this.initLoginConfig(wrapper, appid);

        // 2. 登录：快速登录（优先）→ QR 回退；qrOnly 直接 QR。登录成功前不碰 session。
        const loginResult =
            opts.qrOnly === true
                ? await this.loginByQr(opts)
                : await this.loginQuickFirst(wrapper, opts);
        this.ctx.login = loginResult;

        // 3. 可选：登录成功后自动完成 Session 激活闭环（默认关闭，兼容 loader 手动流程）。
        if (opts.activateSession === true) {
            await this.activateSession({
                appid,
                ...(opts.initTimeoutMs !== undefined ? { timeoutMs: opts.initTimeoutMs } : {}),
            });
        }
        return loginResult;
    }

    /**
     * 激活当前登录账号的 Session（先 init 后 startupSession.start，再等就绪）。
     *
     * 前置：必须已 `attachWrapper` 且 `login` 成功（否则 fail-fast INVALID_STATE）。
     * appid 未传时按 wrapperPath / 环境变量同目录 major.node 自动解析。
     * 幂等性由底层 init 语义决定：重复调用会再次 init（调用方自行保证只激活一次）。
     */
    async activateSession(
        opts: {
            appid?: string | undefined;
            timeoutMs?: number | undefined;
            readyTimeoutMs?: number | undefined;
        } = {},
    ): Promise<void> {
        const { wrapper } = this.ctx;
        const loginResult = this.ctx.login;
        if (wrapper === null || loginResult === null) {
            throw kernelError(
                "请先调用 core.attachWrapper() 与 core.login() 后再激活 session",
                "INVALID_STATE",
            );
        }
        const appid = resolveCoreAppid(wrapper, opts.appid);
        const accountPath = resolveSessionAccountPath(this.ctx, wrapper);
        const sessionConfig = buildSessionConfig({
            appid,
            fullVersion: wrapper.versionInfo.fullVersion,
            selfUin: loginResult.uin,
            selfUid: loginResult.uid,
            accountPath,
            downloadPath: this.ctx.paths.cacheDir,
            machineGuid: readMachineGuid(wrapper.loginService),
        });
        await initAndStartSession(wrapper, sessionConfig, createSessionListener(), {
            ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        });
        await waitSessionReady(wrapper, {
            ...(opts.readyTimeoutMs !== undefined ? { timeoutMs: opts.readyTimeoutMs } : {}),
        });
        this.ctx.logger.info({ account: loginResult.uin }, "Session 激活完成");
    }

    /**
     * 装配开箱即用的内核运行时服务（事件通道 + 桥 + 业务 API + 缓存聚合）。
     * 前置：wrapper 已 attach 且 session 非空（否则 fail-fast INVALID_STATE）。
     * dispose 由 `stop()` / `dispose()` 统一回收。
     */
    createRuntime(
        opts: Omit<KernelRuntimeOptions, "session" | "login" | "wrapperExports"> = {},
    ): KernelRuntime {
        const wrapper = this.ctx.wrapper;
        const session = wrapper?.session;
        if (wrapper === null || session === null || session === undefined) {
            throw kernelError(
                "请先调用 core.attachWrapper() 且 session 非空后再创建运行时",
                "INVALID_STATE",
            );
        }
        const runtime = createKernelRuntime({
            ...opts,
            loginService: opts.loginService ?? wrapper.loginService,
            session,
            login: this.ctx.login,
            wrapperExports: wrapper.exports,
        });
        this.runtime = runtime;
        return runtime;
    }

    /** 快速登录优先，失败按 qrFallback 决定是否回退 QR（QR 应直接出码，见 loginByQr 注）。 */
    private async loginQuickFirst(
        wrapper: WrapperContext,
        opts: CoreLoginOptions,
    ): Promise<LoginResult> {
        try {
            const result = await quickLogin(wrapper, buildQuickLoginOptions(opts));
            this.ctx.logger.info({ uin: result.uin, uid: result.uid }, "快速登录成功");
            return result;
        } catch (err) {
            if (opts.qrFallback !== true) {
                throw err;
            }
            return await this.loginByQr(opts);
        }
    }

    /**
     * loginService.initConfig（worker/自建宿主需指定 QQ 真实数据路径）。
     * worker（utilityProcess）模式 + 自建宿主（标准 node）下 loginService 是
     * new 的，commonPath 必须指向 QQ 真实数据目录（数据根/nt_qq/global，
     * HANDOVER-V6 三要素之三）才能读到历史账号——cli 的 `.napuketto\default`
     * 读不到（getLoginList 空，P2-1 实测 2026-08-06）。
     * QQ 主进程（V1）模式 QQ 自己 initConfig 过正确路径，无需解析。
     */
    private initLoginConfig(wrapper: WrapperContext, appid: string): void {
        const raw = wrapper.loginService;
        if (!isRecord(raw) || !hasInitConfig(raw)) {
            this.ctx.logger.warn("loginService 不可用，跳过 initConfig");
            return;
        }
        const commonPath = resolveCommonPath(this.ctx, wrapper);
        const loginCfg = buildLoginConfig(appid, wrapper.versionInfo.fullVersion, commonPath);
        raw["initConfig"](loginCfg);
        this.ctx.logger.info({ commonPath }, "loginService.initConfig OK");
    }

    /**
     * 替换当前 session（登录后 Proxy 捕获的 QQ 新实例替换自己 create 的无效实例）。
     * 在 QQ 主进程内由 boot.cjs 调用（登录成功后）。
     */
    setSession(session: NodeIQQNTWrapperSession): void {
        if (this.ctx.wrapper === null) {
            throw kernelError("wrapper 未装配，无法设置 session", "INVALID_STATE");
        }
        this.ctx.wrapper.session = session;
    }

    /**
     * 手动刷新二维码（QR 登录期间可用）。返回是否成功触发（false = 当前不在扫码态）。
     * koishi 前端「刷新二维码」按钮经 loader IPC `login.refreshQr` 动作直达。
     */
    refreshQr(): boolean {
        if (this.qrSession === null) {
            return false;
        }
        this.qrSession.refresh();
        return true;
    }

    /** QR 登录：QrLoginSession 状态机 + 二维码写独占缓存目录（无 UI，cli 可打印路径）。 */
    private async loginByQr(opts: CoreLoginOptions): Promise<LoginResult> {
        const { wrapper } = this.ctx;
        if (wrapper === null || wrapper.loginService === null) {
            throw kernelError("wrapper/loginService 不可用，无法 QR 登录", "INVALID_STATE");
        }
        const session = new QrLoginSession(wrapper.loginService);
        // 暴露句柄：登录期间外部可经 refreshQr() 手动刷新二维码（koishi 前端刷新按钮）。
        this.qrSession = session;
        // 调用方显式 qrCodePath 视为自行接管生命周期；默认路径是本次登录的临时材料。
        const explicitPath = opts.qrCodePath;
        const qrPath = explicitPath ?? this.ctx.paths.file("cache", QR_CODE_DIR, QR_CODE_FILENAME);
        this.ephemeralQrCodePath = explicitPath === undefined ? qrPath : null;
        this.subscribeQrProgress(session, opts, qrPath);

        try {
            // 启动 QR 登录（注册监听 → connect → getQRCodePicture）
            // ⚠️ 不传 quickUin（2026-08-13）：QR 回退路径下快速登录已在 core.login
            // 失败过一次，这里再传会导致 QrLoginSession 二次快速登录——无凭据环境
            // 直接 resolve 带 errMsg，白等一个周期才出二维码。QR 登录应直接出码。
            session.start();

            await waitQrLoggedIn(session);
            const self = requireQrSelfInfo(session);
            return { uin: self.uin, uid: self.uid, nick: self.nick };
        } finally {
            session.stop();
            this.qrSession = null;
            this.cleanupEphemeralQrCode();
        }
    }

    /** 订阅 QR 进度：二维码写盘 + 状态机经 onLoginProgress 转发。 */
    private subscribeQrProgress(
        session: QrLoginSession,
        opts: CoreLoginOptions,
        qrPath: string,
    ): void {
        session.onQrCode((qr) => {
            // 日志只留图片路径：qrcodeUrl 是登录 URL（含票据），不得写入日志/事件。
            this.ctx.logger.warn(`请扫描二维码登录（图片: ${qrPath}）`);
            if (qr.pngBase64 !== "") {
                writeQrCodePng(qrPath, qr.pngBase64);
            }
            opts.onLoginProgress?.({ state: "waiting_scan", qr });
        });
        session.onStateChange((state) => {
            this.forwardQrState(session, opts, state);
        });
    }

    /** QR 状态转发：日志 + onLoginProgress（failed 附 failureReason）。 */
    private forwardQrState(
        session: QrLoginSession,
        opts: CoreLoginOptions,
        state: LoginState,
    ): void {
        this.ctx.logger.info({ state }, "QR 登录状态");
        const progress = qrProgressEvent(state, session.selfInfo, session.failureReason);
        if (progress !== null) {
            opts.onLoginProgress?.(progress);
        }
    }

    /**
     * 停止：幂等清理 QR 会话 + 已装配的运行时服务（桥/缓存/通道）后日志收尾。
     * 重复调用直接返回（宿主关停钩子可能同时触发多次）。
     */
    stop(): void {
        if (this.stopped) {
            return;
        }
        this.stopped = true;
        this.qrSession?.stop();
        this.qrSession = null;
        this.cleanupEphemeralQrCode();
        this.runtime?.dispose();
        this.runtime = null;
        this.ctx.logger.info("NapukettoCore 停止");
    }

    /** 删除本次登录默认落盘的临时二维码（显式 qrCodePath 不删）。幂等。 */
    private cleanupEphemeralQrCode(): void {
        const path = this.ephemeralQrCodePath;
        this.ephemeralQrCodePath = null;
        if (path !== null) {
            removeQrCodePng(path);
        }
    }

    /** 显式释放（`using` / 手动调用的统一入口；等价 stop）。 */
    dispose(): void {
        this.stop();
    }

    /** `using core = ...` 自动释放。 */
    [Symbol.dispose](): void {
        this.stop();
    }
}

/** wrapperPath 环境变量键（唯一规范拼写）。 */
const WRAPPER_PATH_ENV_KEY = "NAPUKETTO_WRAPPER_PATH";

/** 解析 wrapperPath：wrapper 上下文优先，其次环境变量。 */
function resolveWrapperPath(wrapper: WrapperContext): string | undefined {
    if (wrapper.wrapperPath !== undefined && wrapper.wrapperPath !== "") {
        return wrapper.wrapperPath;
    }
    const value = process.env[WRAPPER_PATH_ENV_KEY];
    if (value !== undefined && value !== "") {
        return value;
    }
    return undefined;
}

/**
 * appid 解析：显式传入优先；否则从 wrapperPath 同目录 major.node 解析。
 * 仍无法解析时抛清晰的 INVALID_PARAM（不静默回退过期 appid）。
 */
function resolveCoreAppid(wrapper: WrapperContext, explicit: string | undefined): string {
    if (explicit !== undefined && explicit !== "") {
        return explicit;
    }
    const wrapperPath = resolveWrapperPath(wrapper);
    if (wrapperPath !== undefined) {
        try {
            return resolveAppidQua(
                wrapper.versionInfo.fullVersion,
                join(dirname(wrapperPath), "major.node"),
            ).appid;
        } catch {
            // 继续走下方清晰报错（保留原始语义：无法定位 major.node）
        }
    }
    throw kernelError(
        "未提供 appid 且无法自动定位 major.node，请在 CoreLoginOptions.appid 或 BootEnv.wrapperPath 中指定",
        "INVALID_PARAM",
    );
}

/**
 * session 数据目录：worker/自建宿主优先 QQ 真实数据目录（数据根/nt_qq/global），
 * 否则回退账号目录（与 loader bootstrap-core 的激活路径同口径）。
 */
function resolveSessionAccountPath(ctx: CoreContext, wrapper: WrapperContext): string {
    const root = resolveQqUserDataRoot(wrapper.exports, { dataRoot: ctx.paths.root });
    return root !== null ? resolveQqGlobalPath(root) : ctx.paths.accountDir;
}

/**
 * loginService.initConfig 形状守卫（可带一个配置参数调用）。
 * `hasFunctionProp` 的函数类型是「零参可调用」（`(...args: never[])`），
 * 这里需要带参调用，故给一个精确到参数的谓词。
 */
function hasInitConfig(
    val: Record<string, unknown>,
): val is Record<string, unknown> & { initConfig: (config: unknown) => void } {
    return typeof val["initConfig"] === "function";
}

/** 二维码 png 默认落盘目录（账号 cache 下的独占子目录）。 */
const QR_CODE_DIR = "qr";
/** 二维码 png 默认文件名。 */
const QR_CODE_FILENAME = "qrcode.png";

/**
 * 写二维码 png 到磁盘（base64 解码，供 cli/用户扫码）。
 *
 * 安全边界：目录按 0o700 创建、文件按 0o600 写入；写入前拒绝符号链接，避免被
 * 预置链接引到其他文件。失败不阻塞登录（cli 仍可打印 URL / 终端渲染）。
 */
function writeQrCodePng(filePath: string, pngBase64: string): void {
    try {
        mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
        try {
            if (lstatSync(filePath).isSymbolicLink()) {
                return;
            }
        } catch {
            // 文件尚不存在：正常路径
        }
        writeFileSync(filePath, Buffer.from(pngBase64, "base64"), { mode: 0o600 });
        // 已存在的旧文件 mode 不会随 writeFileSync 改变，显式收紧权限。
        chmodSync(filePath, 0o600);
    } catch {
        // 写失败不阻塞登录（cli 仍可打印 URL）
    }
}

/** 删除默认落盘的二维码文件（不存在 / 权限失败静默）。 */
function removeQrCodePng(filePath: string): void {
    try {
        unlinkSync(filePath);
    } catch {
        // 已清理 / 从未落盘
    }
}

/** CoreLoginOptions → quickLogin 参数（仅取快速登录相关两键，QR 键不透传）。 */
function buildQuickLoginOptions(opts: CoreLoginOptions): QuickLoginOptions {
    const quickOpts: QuickLoginOptions = {};
    if (opts.quickUin !== undefined) {
        quickOpts.uin = opts.quickUin;
    }
    if (opts.quickLoginTimeoutMs !== undefined) {
        quickOpts.quickLoginTimeoutMs = opts.quickLoginTimeoutMs;
    }
    return quickOpts;
}

/** QR 登录终态后的 selfInfo 提取（空值按登录失败抛出）。 */
function requireQrSelfInfo(session: QrLoginSession): SelfInfo {
    const self = session.selfInfo;
    if (self === null) {
        throw kernelError("QR 登录成功但 selfInfo 为空", "INVALID_STATE");
    }
    return self;
}

/**
 * QR 进度事件折叠（可辨识联合，判别字段 = state）。
 *
 * 返回 null = 该状态不单独上报：
 *  - waiting_scan：二维码数据由 `subscribeQrProgress` 的 onQrCode 回执发出
 *    （那里才拿得到 qr），状态机这次先不带 qr 的事件不再重复发；
 *  - logged_in 且 selfInfo 仍为空：会话已损坏（调用方随后按 INVALID_STATE 拒绝），
 *    不构造自相矛盾的 logged_in 事件。
 */
function qrProgressEvent(
    state: LoginState,
    selfInfo: SelfInfo | null,
    reason: string | null,
): LoginProgress | null {
    switch (state) {
        case "idle":
            return { state };
        case "waiting_scan":
            return null;
        case "scanned":
            return { state };
        case "logged_in":
            return selfInfo === null ? null : { state, selfInfo };
        case "failed":
            return { state, message: reason ?? "" };
    }
}

/** 等待 QR 登录终态：logged_in resolve，failed reject。 */
function waitQrLoggedIn(session: QrLoginSession): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const offState = session.onStateChange((state) => {
            if (state === "logged_in") {
                offState();
                resolve();
            } else if (state === "failed") {
                offState();
                reject(kernelError("QR 登录失败", "NOT_LOGIN"));
            }
        });
    });
}

/**
 * loginService.initConfig 的 commonPath：
 * worker/自建宿主（非 browser）优先 QQ 真实数据目录（数据根/nt_qq/global），
 * 否则回退账号目录。Linux 下数据根即 Napuketto 数据根（`ctx.paths.root`），
 * Windows 由 QQ 官方 API 定位。
 */
function resolveCommonPath(ctx: CoreContext, wrapper: WrapperContext): string {
    if (electronProcessType() !== "browser") {
        const root = resolveQqUserDataRoot(wrapper.exports, { dataRoot: ctx.paths.root });
        if (root !== null) {
            return resolveQqGlobalPath(root);
        }
    }
    return ctx.paths.accountDir;
}
