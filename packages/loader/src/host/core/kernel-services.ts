/**
 * kernel-services.ts：kernel 业务服务装配（IPC 模式与协议模式共用）。
 *
 * 登录成功后创建：消息/群事件通道 + 桥 + 缓存 + kernel 各 Api + 自身信息。
 * IPC 模式（koishi 插件）经此拿服务装配 ipc-server；非 IPC（cli）经此拿服务
 * 装配 OB11/Satori 适配器。
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "../env.js";
import { setupMsgLogging } from "../msg-log.js";
import type { CoreContextLike, EventChannelLike, KernelLike, LoginResultLike } from "../types.js";
import { errMsg, log } from "../util.js";

/** kernel 业务服务集合（引导装配产物，协议/IPC 共用）。 */
export interface KernelServices {
    kernel: KernelLike;
    ctx: CoreContextLike;
    logger: unknown;
    /** 消息事件通道（Msg/onRecvMsg 等）。 */
    channel: EventChannelLike;
    /** 群事件通道（Group/onGroupListUpdate 等）。 */
    groupChannel: EventChannelLike;
    /** 好友事件通道（Buddy/onBuddyReqChange 等；OB11 request 事件源）。 */
    friendChannel: EventChannelLike;
    /** 好友缓存（B2，2026-09-08：onBuddyListChange 快照 diff → onBuddyAdded/Removed；OB11 friend_add 源）。 */
    buddyCache: unknown;
    /** kernel apis（宽松 unknown，装配方按需断言——OB11 用完整面，IPC 动作表用最小面）。 */
    msgApi: unknown;
    groupApi: unknown;
    friendApi: unknown;
    groupCache: unknown;
    groupNotifyApi: unknown;
    ticketApi: unknown;
    richMediaApi: unknown;
    profileApi: unknown;
    profileLikeApi: unknown;
    webApi: unknown;
    /** 登录账号自身信息（login.getSelf）。 */
    self: { uin: string; nickname: string };
    /** wrapper session（诊断用：IPC 动作表枚举/触发原生服务）。 */
    session: unknown;
    /** wrapper engine（诊断用：initLog 等初始化方法验证）。 */
    engine: unknown;
    /** NodeQQNTWrapperUtil（诊断用：原生 copyFile 验证富媒体文件放置）。 */
    util: unknown;
    /**
     * 释放 kernel 服务资源（软重登重装配前清理，2026-09-08）：注销三条桥 +
     * 群缓存退订 + 消息日志退订。幂等（桥/缓存 unregister 自身判空）。
     * 协议面（OB11 桥 / IPC 事件转发 / cli 模式网络适配器）由各自装配方
     * 的 stop 函数清理，不在本面。
     */
    dispose(): void;
    /**
     * cli 模式（非 IPC）网络适配器停止面（ob11/satori stop，startProtocols
     * 装配后填入）。软重登当前仅 IPC 模式有触发通道（control login），此面
     * 为非 IPC 场景预留的完整清理面。未装配时缺省。
     */
    stopAdapters?: () => Promise<void>;
}

/** 登录成功后创建 kernel 业务服务（channel/bridge/cache/apis）。失败返回 null。 */
export async function createKernelServices(
    kernel: KernelLike,
    ctx: CoreContextLike,
    loginResult: LoginResultLike,
): Promise<KernelServices | null> {
    // IPC 模式关 console：子进程 stdout 专用于 JSON 行协议，pino-pretty 并发写
    // 会撕裂协议行（2026-09-06「能收不能发」事故根因，消息日志经此 logger 每
    // 条消息都会污染）——此行为不可回退。两种模式统一落盘数据目录
    // logs/loader.log（cli 模式 2026-09-10 起同样落盘：poke/Buddy 校准等诊断
    // 数据此前仅 IPC 模式留存，cli 模式全丢）；cli 模式 console 输出保持不变。
    // 消息纯文本另有 napuketto-boot.log 兜底（见 msg-log.ts）。
    const ipcMode = env.NAPUTO_IPC === "1";
    const logFile =
        env.NAPUTO_CFG_DIR !== undefined
            ? join(env.NAPUTO_CFG_DIR, "logs", "loader.log")
            : join(tmpdir(), "napuketto-loader.log");
    const logger = kernel.createLogger?.({
        console: !ipcMode,
        file: logFile,
        base: { name: "loader" },
    });
    const session = ctx.session;
    if (!session) {
        log("bootstrap: session 为空，无法创建 kernel 服务");
        return null;
    }
    // 消息事件通道 + 桥
    const channel = new kernel.NTEventChannel("Msg");
    const bridge = new kernel.MsgBridge(session, channel);
    bridge.register();
    // 控制台消息日志（NapCat 同款：收到消息打印到控制台；渲染逻辑见 msg-log.ts）。
    // 返回退订函数（软重登重装配时清理）。
    const offMsgLogging = setupMsgLogging(kernel, channel, logger, !ipcMode);
    // kernel APIs
    const groupApi = new kernel.GroupApi(session);
    // channel 传入 MsgApi：sendMsg 后等 onMsgInfoListUpdate 确认（NapCat 式，2026-08-11）
    // util 传入 MsgApi：富媒体发送 copyFile（NapCat 式图片预处理，2026-08-11）
    const util = (ctx as unknown as { exports?: { NodeQQNTWrapperUtil?: unknown } }).exports
        ?.NodeQQNTWrapperUtil;
    const msgApi = new kernel.MsgApi(session, channel, util);
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
        log(`bootstrap: 在线状态注册失败（实时消息推送可能不可用）: ${errMsg(statusErr)}`);
    }
    const friendApi = new kernel.FriendApi(session, {
        uidToUin: (uids: string[]) => groupApi.uidToUin(uids),
    });
    // 群事件通道 + 桥 + 群缓存（ADR-008：事件主动维护 + 查询惰性回填）
    const groupChannel = new kernel.NTEventChannel("Group");
    const groupBridge = new kernel.GroupBridge(session, groupChannel);
    groupBridge.register();
    // 好友事件通道 + 桥（OB11 request/friend 事件源，2026-09-08）
    const friendChannel = new kernel.NTEventChannel("Buddy");
    const friendBridge = new kernel.FriendBridge(session, friendChannel);
    friendBridge.register();
    const groupCache = new kernel.GroupCache({ channel: groupChannel, groupApi });
    groupCache.register();
    // 好友缓存（B2）：快照 diff 归一化事件（OB11 friend_add 源）
    const buddyCache = new kernel.BuddyCache({ channel: friendChannel, logger });
    buddyCache.register();
    const groupNotifyApi = new kernel.GroupNotifyApi(session);
    const ticketApi = new kernel.TicketApi(session);
    const richMediaApi = new kernel.RichMediaApi(session);
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
        msgApi,
        groupApi,
        friendApi,
        groupCache,
        buddyCache,
        groupNotifyApi,
        ticketApi,
        richMediaApi,
        profileApi,
        profileLikeApi,
        webApi,
        self: { uin: loginResult.uin, nickname: loginResult.nick ?? "" },
        session,
        engine: ctx.engine,
        // util：wrapper exports 上的 NodeQQNTWrapperUtil（诊断用原生 copyFile）
        util: (ctx as unknown as { exports?: { NodeQQNTWrapperUtil?: unknown } }).exports
            ?.NodeQQNTWrapperUtil,
        dispose: () => {
            // 幂等清理：桥 unregister 判空、groupCache.unsubscribes 判空
            bridge.unregister();
            groupBridge.unregister();
            friendBridge.unregister();
            groupCache.unregister();
            buddyCache.unregister();
            offMsgLogging();
        },
    };
}
