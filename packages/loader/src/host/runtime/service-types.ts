/**
 * service-types.ts：kernel 业务服务集合契约（引导装配产物，协议 / IPC 共用）。
 *
 * 2026-11-25 P1 从 types.ts 拆出：`KernelServices` 是**装配层产物契约**，不是 kernel
 * 提供的接口面；两者放同一文件会让 kernel 契约类型桶继续膨胀。
 *
 * ⚠️ 为什么不能放在 `protocols/kernel-services.ts`：ipc/ 需要消费它，而 ipc/ →
 * protocols/ 的 import 会与 protocols/ → ipc/ 一起构成目录级循环（P0 解环成果）。
 * 本文件在 `host/runtime/`（子进程共享基础层），只依赖 `types.ts`（单向），是两侧
 * 都能安全引用的公共类型层。
 */
import type {
    CoreContextLike,
    EventChannelLike,
    FriendApiLike,
    GroupApiLike,
    GroupCacheLike,
    GroupNotifyApiLike,
    KernelLike,
    LoggerLike,
    MsgApiLike,
} from "./types.js";

/** 接收行绑定过滤 holder（与 msg-log.ts 的 ReceiveLogFilter 结构同构；本文件保持零运行时依赖）。 */
export interface ReceiveLogFilterLike {
    current: ((peerUin: string, isGroup: boolean) => boolean) | null;
}

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
    /** 会话列表事件通道（RecentContact/onRecentContactListChangedVer2；milky peer_pin 源）。 */
    recentContactChannel: EventChannelLike;
    /** 登录状态事件通道（Login/onLoginDisConnected；milky bot_offline 源）。 */
    loginChannel: EventChannelLike;
    /** 好友缓存（B2，2026-09-08：onBuddyListChange 快照 diff → onBuddyAdded/Removed；OB11 friend_add 源）。 */
    buddyCache: { events: EventChannelLike; register(): void; unregister(): void };
    /** kernel apis（精确最小面，装配方直接使用，无需断言）。 */
    msgApi: MsgApiLike;
    groupApi: GroupApiLike;
    friendApi: FriendApiLike;
    groupCache: GroupCacheLike;
    groupNotifyApi: GroupNotifyApiLike;
    ticketApi: unknown;
    richMediaApi: unknown;
    /** 闪传（upload_group_file / upload_private_file 的投递通道，见 kernel design §15）。 */
    flashTransferApi: unknown;
    recentContactApi: unknown;
    profileApi: unknown;
    profileLikeApi: unknown;
    webApi: unknown;
    /** 登录账号自身信息（login.getSelf；uid 供 Milky target_user_uid 等）。 */
    self: { uin: string; nickname: string; uid: string };
    /**
     * ob11 校准日志（loader logger 派生，module=ob11；2026-10-25 模块级别
     * 覆盖 [log.levels].ob11 经 child level 生效）。老 kernel 无 child 时回退主 logger。
     */
    calibLogger: LoggerLike;
    /**
     * 接收行绑定过滤 holder（2026-10-25 P1-7）：kurobot 握手拿到绑定表后填充
     * current（返回该频道是否绑定）；[log].unboundReceive=false 时未绑定频道的
     * 接收行不打。null = 无绑定信息（不过滤）。
     */
    receiveFilter: ReceiveLogFilterLike;
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
