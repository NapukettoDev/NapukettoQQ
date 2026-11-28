import { dirname, join } from "node:path";
import { GroupApi } from "../apis/group/index.js";
import { MsgApi } from "../apis/msg/index.js";
import { kernelError, NTEventChannel } from "../infra/index.js";
import { MsgBridge } from "../native/bridge/msg-bridge.js";
import {
    createHostDiagnostics,
    type DiagnosticActionHandler,
} from "../native/probe/host-diagnostics.js";
import { probeRuntime } from "../native/probe/probe.js";
import {
    type ListenerRecordingResult,
    startListenerRecording,
} from "../native/probe/probe-listener.js";
import { activateO3MiscService, type WrapperContext } from "../native/wrapper/lifecycle.js";
import { dlopenWrapper, resolveQqUserDataRoot } from "../native/wrapper/loader.js";
import { resolveQqGlobalPath } from "../native/wrapper/qq-data-path.js";
import {
    buildSessionConfig,
    readMachineGuid,
    resolveAppidQua,
} from "../native/wrapper/wrapper-config.js";
import type { MsgListener } from "../types/index.js";
import { type CoreLoginOptions, NapukettoCore, type NapukettoCoreOptions } from "./core.js";
import {
    createKernelRuntime,
    type KernelRuntime,
    type KernelRuntimeOptions,
    registerSessionBridges,
} from "./lifecycle.js";
import {
    initAndStartSession,
    type LoginAccountInfo,
    type LoginResult,
    listLoginAccounts,
    waitSessionReady,
} from "./login/index.js";

interface SelfHostIdentity {
    uin: string;
    uid: string;
    nick?: string;
}

export interface SelfHostEnvironment {
    wrapperPath: string;
    qqVersion: string;
    dataDir: string;
    dataRoot: string;
}

interface SelfHostCore {
    login(options: CoreLoginOptions): Promise<LoginResult>;
    refreshQr(): boolean;
}

interface SelfHostMessageServices {
    channel: NTEventChannel<MsgListener, "Msg">;
    msgApi: MsgApi;
    groupApi: GroupApi;
    dispose(): void;
}

type SelfHostRuntime = Omit<
    KernelRuntime,
    "msgBridge" | "groupBridge" | "friendBridge" | "recentContactBridge" | "loginBridge"
> & { startServices(): void };

interface SelfHostSession {
    listLoginAccounts(): Promise<LoginAccountInfo[]>;
    activate(login: SelfHostIdentity, appid: string): Promise<void>;
    waitReady(): Promise<void>;
    mediaBaseDir(): string | undefined;
    createRuntime(login: SelfHostIdentity, logger: KernelRuntimeOptions["logger"]): SelfHostRuntime;
    createMessageServices(): SelfHostMessageServices;
    diagnostics(): ReadonlyMap<string, DiagnosticActionHandler>;
    recordListeners(): ListenerRecordingResult;
    probe(filename?: string): { hasSession: boolean; serviceCount: number };
}

export interface PreparedSelfHost {
    resolveAppid(): string;
    createCore(options: NapukettoCoreOptions): { core: SelfHostCore; attach(): SelfHostSession };
}

/** O3 分发须在 engine 和登录服务装配之前激活。 */
export function prepareSelfHost(env: SelfHostEnvironment): PreparedSelfHost {
    const exports = dlopenWrapper(env.wrapperPath);
    if (!activateO3MiscService(exports)) {
        throw kernelError(
            "O3 事件分发不可用：缺少 NodeIO3MiscService 或监听注册方法",
            "INVALID_STATE",
        );
    }
    return {
        resolveAppid: () =>
            resolveAppidQua(env.qqVersion, join(dirname(env.wrapperPath), "major.node")).appid,
        createCore(options: NapukettoCoreOptions) {
            const core = NapukettoCore.create(options);
            return {
                core: {
                    login: (options) => core.login(options),
                    refreshQr: () => core.refreshQr(),
                },
                attach: () => createHostSession(core.attachWrapper(exports, env), env),
            };
        },
    };
}

function createHostSession(ctx: WrapperContext, env: SelfHostEnvironment): SelfHostSession {
    return {
        listLoginAccounts: () => listLoginAccounts(ctx),
        activate: (login: SelfHostIdentity, appid: string) =>
            activateHostSession(ctx, env, login, appid),
        waitReady: () => waitSessionReady(ctx),
        mediaBaseDir: () => {
            const root = resolveQqUserDataRoot(ctx.exports);
            return root === null ? undefined : resolveQqGlobalPath(root);
        },
        createRuntime: (login: SelfHostIdentity, logger: KernelRuntimeOptions["logger"]) =>
            createHostRuntime(ctx, login, logger),
        createMessageServices: () => createMessageServices(ctx),
        diagnostics: () =>
            createHostDiagnostics({
                session: ctx.session,
                engine: ctx.engine,
                util: ctx.exports.NodeQQNTWrapperUtil,
            }),
        recordListeners: () => startListenerRecording(ctx),
        probe: (filename?: string) => {
            const result = probeRuntime(ctx, filename);
            return {
                hasSession: result["session"] !== null && result["session"] !== undefined,
                serviceCount: Object.keys(result["services"] ?? {}).length,
            };
        },
    };
}

function requireSession(ctx: WrapperContext): NonNullable<WrapperContext["session"]> {
    if (ctx.session === null) {
        throw kernelError("session 未创建", "INVALID_STATE");
    }
    return ctx.session;
}

function createHostRuntime(
    ctx: WrapperContext,
    login: SelfHostIdentity,
    logger: KernelRuntimeOptions["logger"],
): SelfHostRuntime {
    const runtime = createKernelRuntime({
        session: requireSession(ctx),
        login: { ...login, nick: login.nick ?? "" },
        loginService: ctx.loginService,
        wrapperExports: ctx.exports,
        autoRegister: false,
        logger,
    });
    try {
        runtime.msgBridge.register();
    } catch (err) {
        runtime.dispose();
        throw err;
    }
    return Object.assign(runtime, {
        startServices() {
            registerSessionBridges(runtime);
            runtime.groupCache.register();
            runtime.buddyCache.register();
        },
    });
}

function createMessageServices(ctx: WrapperContext): SelfHostMessageServices {
    const session = requireSession(ctx);
    const channel = new NTEventChannel<MsgListener, "Msg">("Msg");
    const msgApi = new MsgApi(session);
    const groupApi = new GroupApi(session);
    const bridge = new MsgBridge(session, channel);
    bridge.register();
    return {
        channel,
        msgApi,
        groupApi,
        dispose() {
            try {
                bridge.unregister();
            } finally {
                channel.dispose();
            }
        },
    };
}

/** 自建宿主复用与 startupSession 配套的 session，先 init 再 start。 */
async function activateHostSession(
    ctx: WrapperContext,
    env: SelfHostEnvironment,
    login: SelfHostIdentity,
    appid: string,
): Promise<void> {
    const session = requireSession(ctx);
    if (hasMessageService(session)) {
        return;
    }
    const root = resolveQqUserDataRoot(
        ctx.exports,
        env.dataRoot !== "" ? { dataRoot: env.dataRoot } : {},
    );
    const accountPath = root !== null ? resolveQqGlobalPath(root) : env.dataDir || ".";
    await initAndStartSession(
        ctx,
        buildSessionConfig({
            appid,
            fullVersion: env.qqVersion,
            selfUin: login.uin,
            selfUid: login.uid,
            accountPath,
            downloadPath: join(accountPath, "NapCat", "temp"),
            machineGuid: readMachineGuid(ctx.loginService),
        }),
        undefined,
        { timeoutMs: 20_000 },
    );
}

function hasMessageService(session: NonNullable<WrapperContext["session"]>): boolean {
    try {
        const service = session.getMsgService();
        return service !== null && service !== undefined;
    } catch {
        // 原生会话初始化前调用 getter 可能抛异常。
        return false;
    }
}
