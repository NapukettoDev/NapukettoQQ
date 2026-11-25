/**
 * NapukettoCore：装配（paths 建目录 → logger → CoreContext）+ 启动（attachWrapper → login → 可选 session 激活）。
 * 无全局单例（ADR-015 推论），每账号每进程一份；appid 由 resolveAppidQua 从 major.node 动态解析（版本绑定，不写死）。
 */

import { createLogger, kernelError, PathWrapper } from "../infra/index.js";
import type { WrapperContext } from "../native/wrapper/lifecycle.js";
import { startNapuketto } from "../native/wrapper/lifecycle.js";
import type { BootEnv } from "../native/wrapper/loader.js";
import { createSessionListener } from "../native/wrapper/wrapper-adapters.js";
import { buildSessionConfig, readMachineGuid } from "../native/wrapper/wrapper-config.js";
import type { NodeIQQNTWrapperSession, WrapperNodeApi } from "../types/index.js";
import { type CoreContext, createCoreContext } from "./context.js";
import {
    buildQuickLoginOptions,
    initLoginConfig,
    resolveCoreAppid,
    resolveSessionAccountPath,
} from "./core-helpers.js";
import type { CoreLoginOptions, NapukettoCoreOptions } from "./core-options.js";
import type { KernelRuntime, KernelRuntimeOptions } from "./lifecycle.js";
import { createKernelRuntime } from "./lifecycle.js";
import {
    initAndStartSession,
    type LoginResult,
    QrLoginSession,
    quickLogin,
    waitSessionReady,
} from "./login/index.js";
import {
    QR_CODE_DIR,
    QR_CODE_FILENAME,
    removeQrCodePng,
    requireQrSelfInfo,
    subscribeQrProgress,
    waitQrLoggedIn,
} from "./login/qr-flow.js";

export type { CoreLoginOptions, NapukettoCoreOptions } from "./core-options.js";
export type { LoginProgress } from "./login/qr-flow.js";

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
     * 不加载 wrapper / 不登录——启动流程由 attachWrapper + login 完成。
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
     * 登录握手（wrapper 契约，实测确认）：
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
        initLoginConfig(this.ctx, wrapper, appid);

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
        subscribeQrProgress(
            { logger: this.ctx.logger, onLoginProgress: opts.onLoginProgress },
            session,
            qrPath,
        );

        try {
            // 启动 QR 登录（注册监听 → connect → getQRCodePicture）
            // ⚠️ 不传 quickUin：QR 回退路径下快速登录已在 core.login
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
