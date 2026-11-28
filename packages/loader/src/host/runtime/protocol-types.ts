/**
 * protocol-types.ts：动态 import 的协议模块最小接口面（adapter 子路径 / network / kernel）。
 * 与 module-loader.ts + module-guards.ts 成对使用：守卫在运行时收窄，类型在这里表达。
 *
 * ⚠️ 构造入参不用 `Record<string, unknown>`：字段名契约会被整体推迟到运行期，
 * adapter 侧重命名某个可选构造项时 loader 的 `tsc` 仍全绿，直到真正启用该协议才踩雷。
 * 故逐协议给结构接口（字段名 = adapter 公开选项名，值类型 = loader 最小结构面），
 * 漂移由 `tests/host/runtime/protocol-types.test-d.ts` 在 `pnpm check` 里四向对拍。
 */
import type { ReceiveLogFilterLike } from "./service-types.js";
import type {
    EventChannelLike,
    FriendApiLike,
    GroupApiLike,
    GroupCacheLike,
    GroupNotifyApiLike,
    LoggerLike,
    MsgApiLike,
} from "./types.js";

/** 配置 schema 最小面（zod 及其他 `parse` 校验器；loader 只做 parse）。 */
export interface ConfigSchemaLike {
    parse(input: unknown): unknown;
}

/**
 * adapter/core `ProtocolConfig`（历史名）构造入参。
 *
 * 对应 kernel `ConfigOptions` 的 loader 侧结构面：`path` 是配置文件路径，`seed` 是已校验
 * 的账号段（内联配置时跳过磁盘）。
 */
export interface ProtocolConfigOptionsLike {
    /** 配置文件绝对路径（内联配置时为哨兵值）。 */
    path: string;
    /** 协议配置 schema（`parse` 校验 + 缺省值兜底）。 */
    schema: ConfigSchemaLike;
    /** 缺省值（通常 `schema.parse({})` 的产物）。 */
    defaults: unknown;
    /** 内存初值（已校验对象，load() 时跳过文件读写）。 */
    seed: unknown;
}

/** adapter 实例生命周期最小面（装配方只调 start / stop）。 */
export interface AdapterLifecycleLike {
    start(): Promise<unknown>;
    stop(): Promise<void>;
}

/** network 广播器实例（`EventBroadcaster` 的 loader 侧最小面）。 */
export type BroadcasterLike = InstanceType<NetworkModuleLike["EventBroadcaster"]>;

/** 登录账号身份（adapter 构造入参 `self` 的 loader 侧结构面）。 */
export interface SelfIdentityLike {
    uin: string;
    nickname: string;
    /** uid（Milky `target_user_uid` / Satori 频道私聊判定用；OB11 不读）。 */
    uid?: string | undefined;
}

/** adapter core 子路径最小面（ProtocolConfig 框架，动态 import）。 */
export interface AdapterCoreModuleLike {
    /** 历史别名（= ConfigBase，loader 动态 import 主用路径）。 */
    ProtocolConfig: new (
        options: ProtocolConfigOptionsLike,
    ) => unknown;
    /** 新名字（与 ProtocolConfig 同值；保留可选以兼容旧 dist）。 */
    ConfigBase?: new (
        options: ProtocolConfigOptionsLike,
    ) => unknown;
}

/** network 包最小面（EventBroadcaster，动态 import；register/unregister 为事件桥所需）。 */
export interface NetworkModuleLike {
    EventBroadcaster: new () => {
        register(adapter: { send: <T>(payload: T) => void }): unknown;
        unregister(adapter: { send: <T>(payload: T) => void }): void;
    };
}

/**
 * Satori 构造入参（`SatoriAdapterOptions` 的 loader 侧结构面）。
 *
 * api 成员保持 loader 的最小镜像 / `unknown`：kernel 实现类带 `private` 成员，
 * 结构镜像无法、也不应还原成实现镜像（详见文件头）。
 */
export interface SatoriAdapterOptionsLike {
    /** 协议配置框架实例（adapter/core ProtocolConfig 产出，loader 不读其成员）。 */
    config: unknown;
    /** 协议事件广播器（一协议一实例，协议隔离不变量）。 */
    broadcaster: BroadcasterLike;
    /** kernel 消息事件通道（消息收链路入口）。 */
    msgChannel: EventChannelLike;
    msgApi: MsgApiLike;
    groupApi: GroupApiLike;
    groupNotifyApi: GroupNotifyApiLike;
    friendApi: FriendApiLike;
    /** 资料 API（loader 侧无最小面）。 */
    profileApi: unknown;
    self: SelfIdentityLike;
    /** 媒体下载缓存目录（已解析为绝对路径）。 */
    cacheDir: string;
    /** QQ NT global 目录（QQ 用户数据根不可解析时为 undefined）。 */
    mediaBaseDir: string | undefined;
    /** 相对媒体根的基准目录（本地媒体路径解析基准，三协议同源）。 */
    localMediaBaseDir: string;
    /** 群 / 成员缓存（动作读缓存用）。 */
    groupCache: GroupCacheLike;
}

/**
 * Kurobot 构造入参（`KurobotAdapterOptions` 的 loader 侧结构面）。
 *
 * 纯出向 WS 客户端协议：无广播器、无传输门面。
 */
export interface KurobotAdapterOptionsLike {
    config: unknown;
    msgChannel: EventChannelLike;
    msgApi: MsgApiLike;
    self: SelfIdentityLike;
    /** 接收行绑定过滤 holder（握手/绑定表更新时填充；未绑定频道是否打接收行）。 */
    receiveFilter: ReceiveLogFilterLike;
    /** pino logger（kernel 未提供 createLogger 时为 undefined）。 */
    logger: LoggerLike | undefined;
}

/** Milky 构造入参（`MilkyAdapterOptions` 的 loader 侧结构面）。 */
export interface MilkyAdapterOptionsLike {
    config: unknown;
    broadcaster: BroadcasterLike;
    /** kernel 消息事件通道（消息收链路入口）。 */
    msgChannel: EventChannelLike;
    /** kernel 群事件通道（群请求 / 邀请推送）。 */
    groupChannel: EventChannelLike;
    /** kernel 好友事件通道（好友申请推送）。 */
    buddyChannel: EventChannelLike;
    /** kernel 会话列表事件通道（peer_pin_change）。 */
    recentContactChannel: EventChannelLike;
    /** kernel 登录状态事件通道（bot_offline）。 */
    loginChannel: EventChannelLike;
    msgApi: MsgApiLike;
    groupApi: GroupApiLike;
    friendApi: FriendApiLike;
    profileApi: unknown;
    /** 扩面依赖（表态度 / 票据 / 精华 / 群通知 / 群文件）；loader 侧无最小面。 */
    profileLikeApi: unknown;
    ticketApi: unknown;
    webApi: unknown;
    groupNotifyApi: GroupNotifyApiLike;
    richMediaApi: unknown;
    flashTransferApi: unknown;
    recentContactApi: unknown;
    self: SelfIdentityLike;
    groupCache: GroupCacheLike;
    /** QQ 客户端版本（get_impl_info 用；未知时 "unknown"）。 */
    qqVersion: string;
    /** 发送远程媒体 URI 的下载缓存目录。 */
    mediaDir: string;
    /** 相对媒体根的基准目录（本地媒体路径解析基准，三协议同源）。 */
    localMediaBaseDir: string;
    /** 校准日志（loader ob11 子 logger 同款 pino 实例）。 */
    logger: LoggerLike;
}

/** OB11 `system` 回调面（get_version_info / clean_cache / download_file / 进程控制）。 */
export interface Ob11SystemOptionsLike {
    /** 运行版本（get_version_info 用）。 */
    appVersion: string;
    /** 缓存清理回调（clean_cache 用）。 */
    cleanCache(): Promise<void>;
    /** 缓存目录（download_file 保存路径）。 */
    cacheDir: string;
    /** QQ NT global 目录（无全局目录时缺省）。 */
    mediaBaseDir?: string | undefined;
    /** 进程退出回调（bot_exit 用）。 */
    exit(): Promise<void>;
    /** 进程重启回调（set_restart 用）。 */
    restart(): Promise<void>;
}

interface Ob11MessageMediaStatsLike {
    readonly items: number;
    readonly totalBytes: number;
    readonly peakBytes: number;
    readonly copiedBytes: number;
    readonly downloadedBytes: number;
    readonly transcodedBytes: number;
    readonly reusedReferenceBytes: number;
    readonly tempFilesCreated: number;
}

/** OB11 构造入参（`OneBot11AdapterOptions` 的 loader 侧结构面）。 */
export interface Ob11AdapterOptionsLike {
    config: unknown;
    onMessageMediaPrepared?:
        | ((stats: Ob11MessageMediaStatsLike) => void | Promise<void>)
        | undefined;
    /** 相对媒体根的基准目录（本地媒体路径解析基准，三协议同源）。 */
    localMediaBaseDir: string;
    broadcaster: BroadcasterLike;
    msgChannel: EventChannelLike;
    /** 群事件通道（Group/onGroupNotifiesUpdated → request 事件源）。 */
    groupChannel: EventChannelLike;
    /** 好友事件通道（Buddy/onBuddyReqChange → request 事件源）。 */
    friendChannel: EventChannelLike;
    /** 好友缓存快照 diff 通道（friend_add 源；缓存未装配时为 undefined）。 */
    buddyCacheEvents: EventChannelLike | undefined;
    /** 校准日志（pino 实例；kernel 未提供 createLogger 时为 undefined）。 */
    logger: LoggerLike | undefined;
    msgApi: MsgApiLike;
    groupApi: GroupApiLike;
    groupNotifyApi: GroupNotifyApiLike;
    friendApi: FriendApiLike;
    ticketApi: unknown;
    richMediaApi: unknown;
    flashTransferApi: unknown;
    profileApi: unknown;
    profileLikeApi: unknown;
    webApi: unknown;
    self: SelfIdentityLike;
    /** 系统类本地回调（版本 / 缓存 / 下载 / 进程控制）。 */
    system: Ob11SystemOptionsLike;
    groupCache: GroupCacheLike;
}

/** OB11 动作最小面（handle 返回 OB11 信封 {status,retcode,data,message}，永不抛）。 */
export interface Ob11ActionLike {
    handle(payload: unknown): Promise<unknown>;
}

/**
 * OB11 适配器实例面（= 生命周期 + IPC 桥专用面）。
 *
 * `subscribeOnly` / `unsubscribeOnly`：IPC 桥模式只订阅收链路、不开传输；
 * `registry`：IPC 动作表按名挂载（`names` 枚举 + `get` 取动作）。
 */
export interface Ob11AdapterLike extends AdapterLifecycleLike {
    subscribeOnly(): Promise<void>;
    unsubscribeOnly(): void;
    registry: {
        names: string[];
        get(name: string): Ob11ActionLike | undefined;
    };
}

/** adapter 包 satori 子路径最小面（@napuketto/adapter，动态 import）。 */
export interface SatoriModuleLike {
    satoriConfigSchema: ConfigSchemaLike;
    NapukettoSatoriAdapter: new (options: SatoriAdapterOptionsLike) => AdapterLifecycleLike;
}

/** adapter 包 kurobot 子路径最小面（@napuketto/adapter，动态 import）。 */
export interface KurobotModuleLike {
    kurobotConfigSchema: ConfigSchemaLike;
    kurobotConfigDefaults: () => unknown;
    NapukettoKurobotAdapter: new (options: KurobotAdapterOptionsLike) => AdapterLifecycleLike;
}

/** adapter 包 milky 子路径最小面（@napuketto/adapter，动态 import）。 */
export interface MilkyModuleLike {
    milkyConfigSchema: ConfigSchemaLike;
    NapukettoMilkyAdapter: new (options: MilkyAdapterOptionsLike) => AdapterLifecycleLike;
}

/** adapter 包 onebot11 子路径最小面（@napuketto/adapter，动态 import）。 */
export interface Ob11ModuleLike {
    ob11ConfigSchema: ConfigSchemaLike;
    NapukettoOneBot11Adapter: new (options: Ob11AdapterOptionsLike) => Ob11AdapterLike;
}
