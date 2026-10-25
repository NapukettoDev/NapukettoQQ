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

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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
    type LoginResult,
    type LoginState,
    type QrCodeData,
    QrLoginSession,
    type QuickLoginOptions,
    quickLogin,
    type SelfInfo,
} from "./login/index.js";
import type { NodeIQQNTWrapperSession, WrapperNodeApi } from "./types/index.js";
import { resolveQqGlobalPath } from "./wrapper/qq-data-path.js";
import { buildLoginConfig } from "./wrapper/wrapper-config.js";
import {
    type BootEnv,
    electronProcessType,
    resolveQqUserDataRoot,
    startNapuketto,
    type WrapperContext,
} from "./wrapper/wrapper-loader.js";

export interface NapukettoCoreOptions {
    /** 数据根 / 账号（透传给 PathWrapper，见 ADR-016）。 */
    paths?: PathOptions;
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

/** 登录进度（IPC 子进程模式经 onLoginProgress 转发；koishi 插件展示二维码/状态用）。 */
export interface LoginProgress {
    /** 登录状态（QR 状态机）。 */
    state: LoginState;
    /** 二维码数据（state=waiting_scan 时有）。 */
    qr?: QrCodeData;
    /** 登录成功 selfInfo（state=logged_in 时有）。 */
    selfInfo?: SelfInfo;
    /** 失败原因（state=failed 时有；如「登录超时，请刷新页面重试」）。 */
    message?: string;
}

/** login 参数。 */
export interface CoreLoginOptions {
    /** appid（登录握手，由 resolveAppidQua 从 major.node 动态解析，不写死）。 */
    appid: string;
    /** session.init 超时（毫秒），默认 15s。 */
    initTimeoutMs?: number;
    /** 指定快速登录账号（缺省遍历历史列表）。 */
    quickUin?: string;
    /**
     * 单步快速登录超时（毫秒，T3 软重登挂起兜底），默认 20s。服务端已有同账号
     * 会话时底层 quickLoginWithUin/getLoginList 永久挂起，超时按登录失败抛出
     * （qrFallback 可接）。底层 promise 无法取消：超时后悬挂丢弃。
     */
    quickLoginTimeoutMs?: number;
    /** 快速登录失败时回退 QR 登录（二维码写缓存目录），默认 false。 */
    qrFallback?: boolean;
    /** 强制扫码：跳过快速登录，直接走 QR 登录（koishi 强制扫码 / 切账号）。默认 false。 */
    qrOnly?: boolean;
    /** QR 二维码图片保存路径（默认缓存目录 qrcode.png）。 */
    qrCodePath?: string;
    /** 登录进度回调（QR 阶段：二维码数据 + 状态变化）。子进程 IPC 模式转发用。 */
    onLoginProgress?: (progress: LoginProgress) => void;
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
        // base.name 用 pino 保留字段（logger name）：pino-pretty 渲染为 (kernel/pid)
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
     * 登录 + session 初始化（wrapper 契约，2026-08-05 实测确认）：
     * loginService.initConfig → 登录（快速/QR）→ **登录成功后** create session + init
     * → 等 onOpentelemetryInit(is_init) 完成信号。成功后填 ctx.login。
     *
     * 关键（实测）：登录前 create()/init 均断言失败（session 未 init / 干扰 QQ）；
     * 登录后 QQ 自己 init 并触发 listener.onOpentelemetryInit——我们只需在登录后
     * create + init 并监听该信号。
     */
    async login(opts: CoreLoginOptions): Promise<LoginResult> {
        const { wrapper } = this.ctx;
        if (wrapper === null) {
            throw kernelError("wrapper 未装配，无法登录", "INVALID_STATE");
        }

        // 1. loginService.initConfig（wrapper 流程：addKernelLoginListener 前）
        this.initLoginConfig(wrapper, opts.appid);

        // 强制扫码（qrOnly）：跳过快速登录，直接 QR 登录（koishi 强制扫码 / 切账号）。
        if (opts.qrOnly === true) {
            const loginResult = await this.loginByQr(opts);
            this.ctx.login = loginResult;
            return loginResult;
        }

        // 2. 登录：快速登录（优先）→ QR 回退。登录成功前不碰 session。
        const loginResult = await this.loginQuickFirst(wrapper, opts);

        // 3. 登录成功即返回。QQ 登录后重建 session（Proxy 捕获新实例），由 boot.cjs
        // 登录成功后 setSession 替换，再自行等待 session 就绪（waitSessionReady）。
        // 不在 login 内等待——替换发生在 login 返回之后，这里等不到。
        this.ctx.login = loginResult;
        return loginResult;
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
        const loginService = wrapper.loginService as {
            initConfig?: (config: unknown) => void;
        } | null;
        if (loginService === null || typeof loginService.initConfig !== "function") {
            this.ctx.logger.warn("loginService 不可用，跳过 initConfig");
            return;
        }
        const commonPath = resolveCommonPath(this.ctx, wrapper);
        const loginCfg = buildLoginConfig(appid, wrapper.versionInfo.fullVersion, commonPath);
        loginService.initConfig(loginCfg);
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

    /** QR 登录：QrLoginSession 状态机 + 二维码写缓存目录（无 UI，cli 可打印路径）。 */
    private async loginByQr(opts: CoreLoginOptions): Promise<LoginResult> {
        const { wrapper } = this.ctx;
        if (wrapper === null || wrapper.loginService === null) {
            throw kernelError("wrapper/loginService 不可用，无法 QR 登录", "INVALID_STATE");
        }
        const session = new QrLoginSession(wrapper.loginService);
        // 暴露句柄：登录期间外部可经 refreshQr() 手动刷新二维码（koishi 前端刷新按钮）。
        this.qrSession = session;
        const qrPath = opts.qrCodePath ?? this.ctx.paths.file("cache", "qrcode.png");
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
        }
    }

    /** 订阅 QR 进度：二维码写盘 + 状态机经 onLoginProgress 转发。 */
    private subscribeQrProgress(
        session: QrLoginSession,
        opts: CoreLoginOptions,
        qrPath: string,
    ): void {
        session.onQrCode((qr) => {
            this.ctx.logger.warn(`请扫描二维码登录（保存: ${qrPath} | URL: ${qr.qrcodeUrl}）`);
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
        opts.onLoginProgress?.(qrProgressEvent(state, session.failureReason ?? undefined));
    }

    /** 停止：日志收尾（资源清理留给 P2 常驻管理）。 */
    stop(): void {
        this.ctx.logger.info("NapukettoCore 停止");
    }
}

/** 写二维码 png 到磁盘（base64 解码，供 cli/用户扫码）。 */
function writeQrCodePng(filePath: string, pngBase64: string): void {
    try {
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, Buffer.from(pngBase64, "base64"));
    } catch {
        // 写失败不阻塞登录（cli 仍可打印 URL）
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

/** QR 进度事件折叠（failed 附 failureReason 为 message，其余不带 message 键）。 */
function qrProgressEvent(state: LoginState, reason: string | undefined): LoginProgress {
    const message = state === "failed" ? reason : undefined;
    return { state, ...(message !== undefined ? { message } : {}) };
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
 * 否则回退账号目录。
 */
function resolveCommonPath(ctx: CoreContext, wrapper: WrapperContext): string {
    if (electronProcessType() !== "browser") {
        const root = resolveQqUserDataRoot(wrapper.exports);
        if (root !== null) {
            return resolveQqGlobalPath(root);
        }
    }
    return ctx.paths.accountDir;
}
