import { tmpdir } from "node:os";
import { join } from "node:path";
import { isShuttingDown, registerShutdownHook } from "../../lifecycle/shutdown.js";
import { log } from "../../shared/boot-log.js";
import { getErrorMessage } from "../../shared/type-guards.js";
import { env, isEnvEnabled } from "../runtime/env.js";
import { defaultLogConfig, resolveLogFilePath } from "../runtime/log-config.js";
import type { KernelServices } from "../runtime/service-types.js";
import type {
    HostSessionLike,
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

function resolveServiceLogFile(logCfg: LogConfigLike | undefined): string {
    return logCfg?.file !== undefined
        ? resolveLogFilePath(logCfg.file.path)
        : env.NAPUKETTO_CFG_DIR !== undefined
          ? join(env.NAPUKETTO_CFG_DIR, "logs", "loader.log")
          : join(tmpdir(), "napuketto-loader.log");
}

async function registerOnlineStatus(msgApi: KernelServices["msgApi"]): Promise<void> {
    // 在线状态注册：自建宿主无 UI，引导链此前无人调 setStatus →
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
    session: HostSessionLike,
    loginResult: LoginResultLike,
    logCfg?: LogConfigLike,
): Promise<KernelServices | null> {
    // IPC 模式关 console：子进程 stdout 专用于 JSON 行协议，控制台日志并发写
    // 会撕裂协议行（「能收不能发」事故根因，消息日志经此 logger 每
    // 条消息都会污染）——此行为不可回退。两种模式统一落盘数据目录
    // logs/loader.log（cli 模式同样落盘：poke/Buddy 校准等诊断
    // 数据此前仅 IPC 模式留存，cli 模式全丢）；cli 模式 console 输出保持不变。
    // 消息纯文本另有 napuketto-boot.log 兜底（见 msg-log.ts）。
    // 级别/格式/时间戳/颜色接 [log] 段 + env
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
    const runtime = session.createRuntime(loginResult, logger);
    const receiveFilter: ReceiveLogFilter = { current: null };
    let offMsgLogging: (() => void) | undefined;
    const dispose = (): void => {
        try {
            offMsgLogging?.();
        } finally {
            runtime.dispose();
        }
    };
    const unregisterShutdown = registerShutdownHook(dispose);
    try {
        offMsgLogging = setupMsgLogging(
            kernel,
            runtime.msgChannel,
            logger,
            !ipcMode && (logCfg?.colorize ?? true),
            logCfg?.unboundReceive === false ? receiveFilter : undefined,
        );
        await registerOnlineStatus(runtime.msgApi);
        if (isShuttingDown()) {
            dispose();
            return null;
        }
        runtime.startServices();
        return {
            kernel,
            logger,
            channel: runtime.msgChannel,
            groupChannel: runtime.groupChannel,
            friendChannel: runtime.friendChannel,
            recentContactChannel: runtime.recentContactChannel,
            loginChannel: runtime.loginChannel,
            msgApi: runtime.msgApi,
            groupApi: runtime.groupApi,
            friendApi: runtime.friendApi,
            groupCache: runtime.groupCache,
            buddyCache: runtime.buddyCache,
            groupNotifyApi: runtime.groupNotifyApi,
            ticketApi: runtime.ticketApi,
            richMediaApi: runtime.richMediaApi,
            flashTransferApi: runtime.flashTransferApi,
            recentContactApi: runtime.recentContactApi,
            profileApi: runtime.profileApi,
            profileLikeApi: runtime.profileLikeApi,
            webApi: runtime.webApi,
            self: { uin: loginResult.uin, nickname: loginResult.nick ?? "", uid: loginResult.uid },
            calibLogger: calibLogger ?? NOOP_LOGGER,
            receiveFilter,
            mediaBaseDir: () => session.mediaBaseDir(),
            diagnostics: () => session.diagnostics(),
            dispose,
        };
    } catch (err) {
        dispose();
        throw err;
    } finally {
        unregisterShutdown();
    }
}
