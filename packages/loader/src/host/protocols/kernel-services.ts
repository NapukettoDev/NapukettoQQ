/**
 * kernel-services.ts：kernel 业务服务装配（IPC 模式与协议模式共用）。
 *
 * 登录成功后创建：消息/群事件通道 + 桥 + 缓存 + kernel 各 Api + 自身信息。
 * IPC 模式（koishi 插件）经此拿服务装配 ipc/server.ts；非 IPC（cli）经此拿服务
 * 装配 OB11/Satori 适配器。
 *
 * 服务集合类型 `KernelServices` 定义在 `host/runtime/service-types.ts`（装配产物契约，
 * IPC 层也要引用；放在本文件会让 ipc/ → protocols/ 形成目录级循环）。
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { isShuttingDown, registerShutdownHook } from "../../lifecycle/shutdown.js";
import { log } from "../../shared/boot-log.js";
import { getErrorMessage } from "../../shared/type-guards.js";
import { env, isEnvEnabled } from "../runtime/env.js";
import { defaultLogConfig, resolveLogFilePath } from "../runtime/log-config.js";
import type { KernelServices } from "../runtime/service-types.js";
import type {
    CoreContextLike,
    EventChannelLike,
    KernelLike,
    LogConfigLike,
    LoggerLike,
    LoginResultLike,
} from "../runtime/types.js";
import { type ReceiveLogFilter, setupMsgLogging } from "./msg-log.js";

export type { KernelServices } from "../runtime/service-types.js";

/** 静默 logger（kernel.createLogger 不可用时的兜底）。 */
const NOOP_LOGGER: LoggerLike = {
    info: () => {
        // 静默兜底
    },
    warn: () => {
        // 静默兜底
    },
    error: () => {
        // 静默兜底
    },
    debug: () => {
        // 静默兜底
    },
};

/** loader logger 构造参数类型（KernelLike.createLogger 入参）。 */
type LoaderLoggerOptions = Parameters<NonNullable<KernelLike["createLogger"]>>[0];

/** loader logger 构造参数（[log] 段 + IPC/文件路径折叠；直传 undefined，免条件展开）。 */
function buildLoaderLoggerOptions(
    logCfg: LogConfigLike | undefined,
    consoleEnabled: boolean,
    logFile: string,
    account: string,
): LoaderLoggerOptions {
    const cfg = logCfg ?? defaultLogConfig();
    return {
        console: consoleEnabled,
        file: logFile,
        fileLevel: cfg.file?.level,
        level: cfg.levels.loader ?? cfg.level,
        format: cfg.format,
        timestamp: cfg.timestamp,
        colorize: cfg.colorize,
        base: { name: "loader", account },
    };
}

/**
 * 批次三通道与桥（2026-11-01）：RecentContactBridge（peer_pin_change 源）+
 * LoginBridge（bot_offline 源）。loginService 取自 wrapper 上下文（与
 * QrLoginSession 同源），缺失（老 kernel / 未 attach）时只跳过 Login 桥注册
 * ——通道保留，事件为空。
 */
function createBatch3Channels(
    kernel: KernelLike,
    ctx: CoreContextLike,
    session: unknown,
    log: (msg: string) => void,
): { recentContactChannel: EventChannelLike; loginChannel: EventChannelLike; unregister(): void } {
    const recentContactChannel = new kernel.NTEventChannel("RecentContact");
    const recentContactBridge = new kernel.RecentContactBridge(session, recentContactChannel);
    recentContactBridge.register();
    const loginChannel = new kernel.NTEventChannel("Login");
    const loginService = ctx.wrapper?.loginService;
    let loginBridge: { register(): void; unregister(): void } | null = null;
    if (loginService !== null && loginService !== undefined) {
        loginBridge = new kernel.LoginBridge(loginService, loginChannel);
        loginBridge.register();
    } else {
        log("bootstrap: loginService 不可用，Login 桥未注册（bot_offline 事件不可用）");
    }
    return {
        recentContactChannel,
        loginChannel,
        unregister: () => {
            recentContactBridge.unregister();
            loginBridge?.unregister();
        },
    };
}

function resolveServiceLogFile(logCfg: LogConfigLike | undefined): string {
    return logCfg?.file !== undefined
        ? resolveLogFilePath(logCfg.file.path)
        : env.NAPUKETTO_CFG_DIR !== undefined
          ? join(env.NAPUKETTO_CFG_DIR, "logs", "loader.log")
          : join(tmpdir(), "napuketto-loader.log");
}

async function registerOnlineStatus(msgApi: KernelServices["msgApi"]): Promise<void> {
    // 在线状态注册（2026-09-15 发现 I）：自建宿主无 UI，引导链此前无人调 setStatus →
    // NT 会话半在线（msf 连接可用、消息可发，但腾讯侧设备不在线）→ 服务端不推送实时
    // 消息（群消息收不到、他端显示「电脑未登录」）。真 QQNT 客户端启动即上报在线，此处
    // 补同款调用（IPC 与协议模式共用此装配面，软重登重装配时随 services 重建自动重报）；
    // status=10 与 OB11 set_online_status 动作缺省一致。失败仅告警不阻断 boot——
    // 收发链路其余部分已实证可用，状态缺失只影响推送。
    try {
        await msgApi.setOnlineStatus({
            status: 10,
            extStatus: 0,
            batteryStatus: 0,
            customStatus: { faceId: "", wording: "", faceType: "1" },
        });
        log("bootstrap: 在线状态已注册（setStatus status=10）");
    } catch (statusErr) {
        log(`bootstrap: 在线状态注册失败（实时消息推送可能不可用）: ${getErrorMessage(statusErr)}`);
    }
}

/** 登录成功后创建 kernel 业务服务（channel/bridge/cache/apis）。失败返回 null。 */
export async function createKernelServices(
    kernel: KernelLike,
    ctx: CoreContextLike,
    loginResult: LoginResultLike,
    logCfg?: LogConfigLike,
): Promise<KernelServices | null> {
    // IPC 模式关 console：子进程 stdout 专用于 JSON 行协议，控制台日志并发写
    // 会撕裂协议行（2026-09-06「能收不能发」事故根因，消息日志经此 logger 每
    // 条消息都会污染）——此行为不可回退。两种模式统一落盘数据目录
    // logs/loader.log（cli 模式 2026-09-10 起同样落盘：poke/Buddy 校准等诊断
    // 数据此前仅 IPC 模式留存，cli 模式全丢）；cli 模式 console 输出保持不变。
    // 消息纯文本另有 napuketto-boot.log 兜底（见 msg-log.ts）。
    // 2026-10-25 日志可配置化：级别/格式/时间戳/颜色接 [log] 段 + env
    //（boot 经 NAPUKETTO_LOG_FORMAT/COLORIZE 传播顶层控制台决策）；[log.file]
    // 配置时改写该独立 sink（否则沿用 loader.log）。
    const ipcMode = isEnvEnabled(env.NAPUKETTO_IPC);
    const logFile = resolveServiceLogFile(logCfg);
    const logger = kernel.createLogger?.(
        buildLoaderLoggerOptions(logCfg, !ipcMode, logFile, loginResult.uin),
    );
    // ob11 校准子 logger：module=ob11（json/结构化通道可按模块路由），级别
    // [log.levels].ob11 独立可调（默认随全局——校准数据已降 debug）
    const ob11Level = logCfg?.levels.ob11;
    const calibLogger: LoggerLike | undefined =
        logger !== undefined && typeof logger.child === "function"
            ? ob11Level !== undefined
                ? logger.child({ module: "ob11" }, { level: ob11Level })
                : logger.child({ module: "ob11" })
            : logger;
    const session = ctx.session;
    if (!session) {
        log("bootstrap: session 为空，无法创建 kernel 服务");
        return null;
    }
    const disposeHooks: Array<() => void> = [];
    const dispose = (): void => {
        for (const stop of disposeHooks.splice(0).reverse()) {
            try {
                stop();
            } catch (err) {
                log(`bootstrap: kernel 服务清理失败: ${getErrorMessage(err)}`);
            }
        }
    };
    const unregisterShutdown = registerShutdownHook(dispose);
    try {
        // 消息事件通道 + 桥
        const channel = new kernel.NTEventChannel("Msg");
        const bridge = new kernel.MsgBridge(session, channel);
        disposeHooks.push(() => bridge.unregister());
        bridge.register();
        // 控制台消息日志（NapCat 同款：收到消息打印到控制台；渲染逻辑见 msg-log.ts）。
        // 返回退订函数（软重登重装配时清理）。接收行已降 debug（2026-10-25 级别
        // 重分配）；[log].unboundReceive=false 时按 kurobot 绑定表过滤未绑定频道。
        // 接收行颜色：IPC 关；colorize 决策传播（env）缺省保持彩色（终端现状）。
        const receiveFilter: ReceiveLogFilter = { current: null };
        const offMsgLogging = setupMsgLogging(
            kernel,
            channel,
            logger,
            !ipcMode && (logCfg?.colorize ?? true),
            logCfg?.unboundReceive === false ? receiveFilter : undefined,
        );
        disposeHooks.push(offMsgLogging);
        // kernel APIs
        const groupApi = new kernel.GroupApi(session);
        // channel 传入 MsgApi：sendMsg 后等 onMsgInfoListUpdate 确认（NapCat 式，2026-08-11）
        // util 传入 MsgApi：富媒体发送 copyFile（NapCat 式图片预处理，2026-08-11）
        const util = ctx.exports?.["NodeQQNTWrapperUtil"];
        const msgApi = new kernel.MsgApi(session, channel, util);
        await registerOnlineStatus(msgApi);
        if (isShuttingDown()) {
            dispose();
            return null;
        }
        const friendApi = new kernel.FriendApi(session, {
            uidToUin: (uids: string[]) => groupApi.uidToUin(uids),
        });
        // 群事件通道 + 桥 + 群缓存（ADR-008：事件主动维护 + 查询惰性回填）
        const groupChannel = new kernel.NTEventChannel("Group");
        const groupBridge = new kernel.GroupBridge(session, groupChannel);
        disposeHooks.push(() => groupBridge.unregister());
        groupBridge.register();
        // 好友事件通道 + 桥（OB11 request/friend 事件源，2026-09-08）
        const friendChannel = new kernel.NTEventChannel("Buddy");
        const friendBridge = new kernel.FriendBridge(session, friendChannel);
        disposeHooks.push(() => friendBridge.unregister());
        friendBridge.register();
        // 批次三通道 + 桥（peer_pin / bot_offline 源，2026-11-01）
        const batch3 = createBatch3Channels(kernel, ctx, session, log);
        disposeHooks.push(batch3.unregister);
        const groupCache = new kernel.GroupCache({ channel: groupChannel, groupApi });
        disposeHooks.push(() => groupCache.unregister());
        groupCache.register();
        // 好友缓存（B2）：快照 diff 归一化事件（OB11 friend_add 源）
        const buddyCache = new kernel.BuddyCache({ channel: friendChannel, logger });
        disposeHooks.push(() => buddyCache.unregister());
        buddyCache.register();
        const groupNotifyApi = new kernel.GroupNotifyApi(session);
        const ticketApi = new kernel.TicketApi(session);
        const richMediaApi = new kernel.RichMediaApi(session);
        const flashTransferApi = new kernel.FlashTransferApi(session);
        // 会话列表（P2 批次二 get_peer_pins 数据源）
        const recentContactApi = new kernel.RecentContactApi(session);
        const profileApi = new kernel.ProfileApi(session);
        const profileLikeApi = new kernel.ProfileLikeApi(session);
        // 群空间 web API（Cookie 经 TicketApi.getCookies 注入）
        const webApi = new kernel.WebApi({
            getCookies: (domain: string) => ticketApi.getCookies(domain, loginResult.uin),
        });
        return {
            kernel,
            ctx,
            logger,
            channel,
            groupChannel,
            friendChannel,
            recentContactChannel: batch3.recentContactChannel,
            loginChannel: batch3.loginChannel,
            msgApi,
            groupApi,
            friendApi,
            groupCache,
            buddyCache,
            groupNotifyApi,
            ticketApi,
            richMediaApi,
            flashTransferApi,
            recentContactApi,
            profileApi,
            profileLikeApi,
            webApi,
            self: { uin: loginResult.uin, nickname: loginResult.nick ?? "", uid: loginResult.uid },
            calibLogger: calibLogger ?? NOOP_LOGGER,
            receiveFilter,
            session,
            engine: ctx.engine,
            // util：wrapper exports 上的 NodeQQNTWrapperUtil（诊断用原生 copyFile）
            util: ctx.exports?.["NodeQQNTWrapperUtil"],
            dispose,
        };
    } catch (err) {
        dispose();
        throw err;
    } finally {
        unregisterShutdown();
    }
}
