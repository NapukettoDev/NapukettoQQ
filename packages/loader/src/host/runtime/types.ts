/**
 * types.ts：自建宿主引导的类型层——与 @napuketto/kernel 的最小交互面（自研描述，避免包级依赖）。
 * loader 运行期靠 file:// 动态 import kernel、编译期不建 workspace 依赖，故此处的接口由运行时行为实证维护，勿臆造成员。
 * ⚠️ 纯类型文件（0 运行时导出）：运行时常量见 contract/constants.ts，协议模块接口见 runtime/protocol-types.ts。
 */

/**
 * 群请求引用最小面（与 `contract/ipc-schema.ts` 的 `IpcGroupRequest.request` 结构兼容）。
 *
 * 结构兼容定义（而非 `import type { IpcGroupRequest }`）的原因：runtime/ 是 ipc/ 的
 * 上游，反向引用会制造 `runtime <-> ipc` 类型环。字段面由 ipc 侧 zod schema
 * 校验，两侧形状一致由单测与类型赋值双向守卫。
 */
export interface GroupRequestRefLike {
    seq: string;
    groupCode: string;
    /** 请求类型（邀请 / 被邀请入群 / 主动申请）。 */
    kind: "invitation" | "invited_join_request" | "join_request";
    doubt: boolean;
}

/** 群请求最小面（= `IpcGroupRequest` 去掉 `selfUin` / `initiatorUin`）。 */
export interface GroupRequestLike {
    request: GroupRequestRefLike;
    initiatorUid?: string;
    targetUid?: string;
    comment?: string;
}

/**
 * 引导环境（qqVersion / dataDir / dataRoot / wrapperPath，来自 env 快照）。
 *
 * 定义在类型层（而非 bootstrap/core.ts）的原因：bootstrap 主流程、session 激活、
 * 探测三个模块都要消费它，放在任一侧都会制造 `bootstrap/core <-> 子模块` 的
 * 类型级环形依赖。
 */
export interface BootstrapEnv {
    qqVersion: string;
    dataDir: string;
    /** 数据根（Linux 和调试沙箱下 QQ 数据存放在 `<dataRoot>/nt_qq`）。 */
    dataRoot: string;
    wrapperPath: string;
}

/** 消息事件通道（NTEventChannel 的最小面）。 */
export interface EventChannelLike {
    on(event: string, handler: (payload: unknown) => void): unknown;
    /** 全事件订阅（IPC 子进程模式整通道转发用）。 */
    onAny?(handler: (event: string, ...args: unknown[]) => void): unknown;
}

/** pino logger 最小面（kernel `createLogger` 返回值，自研描述，运行时实证）。 */
export interface LoggerLike {
    info(obj: unknown, msg?: string): void;
    warn(obj: unknown, msg?: string): void;
    error(obj: unknown, msg?: string): void;
    /** 级别重分配：接收行/校准数据降 debug。 */
    debug(obj: unknown, msg?: string): void;
    /** 派生子 logger（ob11 校准模块等；options.level 覆盖级别）。 */
    child?(bindings: Record<string, unknown>, options?: { level?: string }): LoggerLike;
}

/** 群 API 最小面（uin↔uid 双向映射 + IPC 动作表查询面）。 */
export interface GroupApiLike {
    uidToUin(uins: string[]): Promise<Map<string, string>>;
    uinToUid(uins: string[]): Promise<Map<string, string>>;
    getGroupList(force?: boolean): Promise<unknown[]>;
    getGroupMemberList(groupCode: string, forceFetch?: boolean): Promise<unknown[]>;
    getGroupMemberInfo(groupCode: string, uids: string[]): Promise<unknown[]>;
}

/** 群缓存最小面（IPC 动作表查询面）。 */
export interface GroupCacheLike {
    listGroupsRefreshed(): Promise<Array<{ groupCode: string; groupName: string }>>;
    getMember?(groupCode: string, uid: string): Promise<{ uid: string; nick?: string } | undefined>;
}

/** 好友 API 最小面。 */
export interface FriendApiLike {
    getFriendList(): Promise<unknown[]>;
}

/** 群请求语义 API。可选方法允许宿主用旧 kernel 装配其他业务。 */
export interface GroupNotifyApiLike {
    getPendingGroupRequests?(doubt: boolean, notifies: unknown): GroupRequestLike[];
    respondToRequest?(
        request: GroupRequestRefLike,
        approve: boolean,
        reason?: string,
    ): Promise<void>;
}

/** 消息 API 最小面（IPC 动作表 + 协议适配共用）。 */
export interface MsgApiLike {
    sendMessage(
        peer: { chatType: number; peerUid: string },
        elements: unknown[],
    ): Promise<{ msgId: string }>;
    recallMessage(peer: { chatType: number; peerUid: string }, msgIds: string[]): Promise<void>;
    fetchMessages(
        peer: { chatType: number; peerUid: string },
        options: { count: number; msgId?: string },
    ): Promise<unknown[]>;
    setMsgEmojiLikeById?(
        peer: { chatType: number; peerUid: string },
        options: { msgId: string; emojiId: string; like: boolean },
    ): Promise<void>;
    markRead(peer: { chatType: number; peerUid: string }): Promise<void>;
    /** 设置在线状态（自建宿主无 UI，引导链必须显式上报——缺它 = 半在线无推送）。 */
    setOnlineStatus(opts: {
        status: number;
        extStatus: number;
        batteryStatus: number;
        customStatus?: { faceId: string; wording: string; faceType: string };
    }): Promise<void>;
}

/** canonical 消息元素（text/at/face/...，kernel toCanonicalElements 输出）。 */
export interface CanonicalElementLike {
    type: string;
    text?: string;
    /** at 目标（uid / "all"，日志渲染用）。 */
    target?: string;
    /** at 显示名（QQ content 剥 @，日志渲染用）。 */
    display?: string;
    /** file 文件名（日志渲染用）。 */
    name?: string;
}

/** 登录结果（kernel LoginResult 最小面）。 */
export interface LoginResultLike {
    uin: string;
    uid: string;
    nick?: string;
}

/** 登录账号（kernel listLoginAccounts 返回项）。 */
export interface LoginAccountLike {
    uin: string;
    nickName?: string | undefined;
    isQuickLogin?: boolean | undefined;
}

/** 登录进度（QR 流程：二维码数据 + 状态变化）。 */
export interface LoginProgressLike {
    state: string;
    qr?: { pngBase64: string; qrcodeUrl: string } | undefined;
    selfInfo?: { uin: string; uid: string; nick: string } | undefined;
    message?: string | undefined;
}

/** kernel CoreLoginOptions 最小面（登录参数，字段全部可选）。 */
export interface CoreLoginOptionsLike {
    appid?: string | undefined;
    initTimeoutMs?: number | undefined;
    quickUin?: string | undefined;
    quickLoginTimeoutMs?: number | undefined;
    qrFallback?: boolean | undefined;
    qrOnly?: boolean | undefined;
    qrCodePath?: string | undefined;
    onLoginProgress?: ((progress: LoginProgressLike) => void) | undefined;
    activateSession?: boolean | undefined;
}

export interface CoreLike {
    login(options: CoreLoginOptionsLike): Promise<LoginResultLike | null>;
    refreshQr?: () => boolean;
}

/** kernel startListenerRecording 逐服务注册结果（batch-3 前置探测，milky.md §0.8.1）。 */
export interface ListenerRegistrationLike {
    ok: boolean;
    listenerId?: number;
    error?: string | null;
}

/** kernel startListenerRecording 结果。 */
export interface ListenerRecordingResultLike {
    file: string;
    registered: Record<string, ListenerRegistrationLike>;
}

/** [log] 配置解析结果最小面（kernel parseLogConfig 返回值，字段语义见 kernel）。 */
type HostLogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal" | "silent";

export interface LogConfigLike {
    level: HostLogLevel;
    format?: "pretty" | "single-line" | "json";
    banner: boolean;
    timestamp?: "local" | "iso8601" | "elapsed";
    unboundReceive: boolean;
    levels: Partial<Record<"cli" | "kernel" | "loader" | "ob11", HostLogLevel>>;
    file?: { path: string; level: HostLogLevel };
    colorize?: boolean;
}

export interface HostCoreOptions {
    paths: { dataRoot: string; account?: string };
    logLevel: LogConfigLike["level"];
    consoleLog?: boolean;
    logFormat?: NonNullable<LogConfigLike["format"]>;
    logTimestamp?: NonNullable<LogConfigLike["timestamp"]>;
    logColorize?: boolean;
    logFileLevel?: LogConfigLike["level"] | undefined;
    logFile?: string;
    account?: string;
}

export type HostDiagnosticAction = (params: Record<string, unknown>) => Promise<unknown>;

export interface HostMessageServicesLike {
    readonly msgApi: MsgApiLike;
    readonly groupApi: GroupApiLike;
    dispose(): void;
}

export interface HostRuntimeLike extends HostMessageServicesLike {
    startServices(): void;
    readonly msgChannel: EventChannelLike;
    readonly groupChannel: EventChannelLike;
    readonly friendChannel: EventChannelLike;
    readonly recentContactChannel: EventChannelLike;
    readonly loginChannel: EventChannelLike;
    readonly groupCache: GroupCacheLike;
    readonly buddyCache: { events: EventChannelLike };
    readonly friendApi: FriendApiLike;
    readonly groupNotifyApi: GroupNotifyApiLike;
    readonly ticketApi: unknown;
    readonly richMediaApi: unknown;
    readonly flashTransferApi: unknown;
    readonly recentContactApi: unknown;
    readonly profileApi: unknown;
    readonly profileLikeApi: unknown;
    readonly webApi: unknown;
}

export interface HostSessionLike {
    listLoginAccounts(): Promise<LoginAccountLike[]>;
    activate(login: LoginResultLike, appid: string): Promise<void>;
    waitReady(): Promise<void>;
    mediaBaseDir(): string | undefined;
    createRuntime(login: LoginResultLike, logger: LoggerLike | undefined): HostRuntimeLike;
    createMessageServices(): HostMessageServicesLike & { channel: EventChannelLike };
    diagnostics(): ReadonlyMap<string, HostDiagnosticAction>;
    recordListeners(): ListenerRecordingResultLike;
    probe(filename?: string): { hasSession: boolean; serviceCount: number };
}

export interface PreparedHostLike {
    resolveAppid(): string;
    createCore(options: HostCoreOptions): { core: CoreLike; attach(): HostSessionLike };
}

/** 模块由 loader 动态导入，编译期不依赖 kernel。 */
export interface KernelLike {
    prepareSelfHost(env: BootstrapEnv): PreparedHostLike;
    resolveSandboxWritePath?: (path: string, field: string) => string;
    // 消息 / 桥 / 服务
    // ChatType 是 kernel 常量对象（GROUP/C2C），Record 字面量键规避 useNamingConvention
    ChatType: Record<"GROUP" | "C2C", number>;
    toCanonicalElements(msg: unknown): CanonicalElementLike[];
    parseToml(raw: string): Record<string, unknown>;
    /** [log] 段解析（toml [log] 原对象 + env 快照 → LogConfigLike；老 kernel 缺失走缺省）。 */
    parseLogConfig?: (section: unknown, env?: Record<string, string | undefined>) => LogConfigLike;
    // 日志（ADR-007）：kernel createLogger，loader 引导进程自建实例
    // （IPC 模式 console:false + file 落盘——stdout 专用于 JSON 行协议）；
    // 可选属性带 | undefined（kernel Optional 约定：装配层可直传可能为
    // undefined 的 [log] 字段，免条件展开）
    createLogger?: (opts: {
        level?: string | undefined;
        console?: boolean;
        file?: string;
        fileLevel?: string | undefined;
        format?: string | undefined;
        timestamp?: string | undefined;
        colorize?: boolean | undefined;
        base?: Record<string, unknown>;
    }) => LoggerLike;
    PathWrapper: new (options: {
        dataRoot?: string | undefined;
        account: string;
    }) => {
        clearCache(): void;
    };
}
