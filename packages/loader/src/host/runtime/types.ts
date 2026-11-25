/**
 * types.ts：自建宿主引导的类型层（2026-08-07 阶段 2 新增）。
 *
 * 与 @napuketto/kernel 的最小交互面（KernelLike 等）——自研描述，避免包级依赖：
 * loader 运行时通过 file:// 动态 import kernel，编译期不建立 workspace 依赖，
 * 因此这里用「最小接口」描述 kernel 的契约（类型层自研，与 kernel 实现解耦，
 * 由运行时行为实证维护，勿臆造成员）。
 *
 * ⚠️ 本文件是**纯类型文件**（2026-11-25 分层约束）：0 运行时导出。运行时常量见
 * `contract/constants.ts`，动态协议模块接口见 `runtime/protocol-types.ts`。改这里不要加值。
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
    /** 全事件订阅（IPC 子进程模式整通道转发用；kernel 2026-08-08 新增）。 */
    onAny?(handler: (event: string, ...args: unknown[]) => void): unknown;
}

/** 事件桥（MsgBridge 最小面）。 */
export interface BridgeLike {
    register(): void;
    unregister(): void;
}

/** pino logger 最小面（kernel `createLogger` 返回值，自研描述，运行时实证）。 */
export interface LoggerLike {
    info(obj: unknown, msg?: string): void;
    warn(obj: unknown, msg?: string): void;
    error(obj: unknown, msg?: string): void;
    /** 2026-10-25 级别重分配：接收行/校准数据降 debug。 */
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
    /** 设置在线状态（自建宿主无 UI，引导链必须显式上报——缺它 = 半在线无推送，2026-09-15 发现 I）。 */
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
    nickName?: string;
    isQuickLogin?: boolean;
}

/** CoreContext（kernel NapukettoCore.create → attachWrapper 返回）。 */
export interface CoreContextLike {
    session?: unknown;
    engine?: unknown;
    login?: { uin?: string; uid?: string; nick?: string };
    /** 老 kernel 回退路径（startNapuketto 手工 lifecycle）。 */
    loginService?: unknown;
    /** wrapper exports（NodeQQNTWrapperUtil 等诊断面）。 */
    exports?: Record<string, unknown>;
    /** wrapper 上下文（LoginBridge 取 loginService：拦截 new 捕获 / 单例 get()）。 */
    wrapper?: {
        loginService?: unknown;
        exports?: Record<string, unknown>;
    } | null;
}

/** NapukettoCore（kernel 装配层）。 */
export interface CoreLike {
    attachWrapper(wrapperExports: unknown, env: Record<string, unknown>): CoreContextLike;
    login(options: Record<string, unknown>): Promise<LoginResultLike | null>;
    setSession(session: unknown): void;
    /** 手动刷新二维码（QR 登录期间可用；返回是否触发，false = 不在扫码态）。 */
    refreshQr?: () => boolean;
}

/** kernel probeRuntime 结果。 */
export interface ProbeResultLike {
    session?: unknown;
    services?: Record<string, unknown>;
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
export interface LogConfigLike {
    level: string;
    format?: string;
    banner: boolean;
    timestamp?: string;
    unboundReceive: boolean;
    levels: Partial<Record<"cli" | "kernel" | "loader" | "ob11", string>>;
    file?: { path: string; level: string };
    colorize?: boolean;
}

/**
 * 与 @napuketto/kernel 的最小交互面。
 * 可选成员 = 老 kernel 兼容路径（startNapuketto/quickLogin 等回退分支）；
 * 必选成员 = 自建宿主主路径（2026-08-07 实测）必须存在。
 */
export interface KernelLike {
    dlopenWrapper?: (path: string) => Record<string, unknown>;
    activateO3MiscService?: (exports: Record<string, unknown>) => boolean;
    resolveSandboxWritePath?: (path: string, field: string) => string;
    // 装配层
    NapukettoCore?: {
        create(options: {
            paths: { dataRoot?: string | undefined };
            logLevel?: string | undefined;
            /** IPC 模式传 false：stdout 专用于 JSON 行协议，console 流会撕裂协议行。 */
            consoleLog?: boolean;
            /** 控制台格式/时间戳/颜色 + 文件级别/路径 + 账号标注（2026-10-25 日志可配置化）。 */
            logFormat?: string;
            logTimestamp?: string;
            logColorize?: boolean;
            logFileLevel?: string;
            logFile?: string;
            account?: string;
        }): CoreLike;
    };
    startNapuketto?: (options: {
        wrapperExports: unknown;
        env: Record<string, unknown>;
    }) => CoreContextLike;
    // 登录
    listLoginAccounts(ctx: CoreContextLike): Promise<LoginAccountLike[]>;
    quickLogin?: (ctx: CoreContextLike, options: unknown) => Promise<LoginResultLike>;
    buildLoginConfig?: (appid: string | number, version: string, dataDir: string) => unknown;
    // session
    getMainSession?: (ctx: CoreContextLike) => unknown;
    buildSessionConfig(options: unknown): unknown;
    /** 读取设备指纹 guid（loginService.getMachineGuid，kernel 原生反射；缺省空串）。 */
    readMachineGuid?: (loginService: unknown) => string;
    createLifecycleSessionListener(): unknown;
    initAndStartSession(
        ctx: CoreContextLike,
        config: unknown,
        listener: unknown,
        options: { timeoutMs: number },
    ): Promise<unknown>;
    waitSessionReady(ctx: CoreContextLike, options: { timeoutMs: number }): Promise<unknown>;
    // 路径 / appid
    parseAppidFromMajor?: (majorPath: string) => string | null;
    resolveAppidQua?: (fullVersion: string, majorPath?: string) => { appid: string; qua: string };
    resolveQqUserDataRoot?: (
        wrapperExports: unknown,
        options?: { dataRoot?: string },
    ) => string | null;
    resolveQqGlobalPath?: (qqDataRoot: string) => string;
    // 探测
    probeRuntime?: (ctx: CoreContextLike, filename?: string) => ProbeResultLike;
    /** listener 录制器（批次三前置；必须先于 probeRuntime——getMainSession 写回毒化 ctx.session）。 */
    startListenerRecording?: (
        ctx: CoreContextLike,
        filename?: string,
    ) => ListenerRecordingResultLike;
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
    NTEventChannel: new (name: string) => EventChannelLike;
    MsgBridge: new (session: unknown, channel: EventChannelLike) => BridgeLike;
    // channel 可选（NapCat 式发送确认，2026-08-11）；util 可选（富媒体 copyFile，2026-08-11）
    MsgApi: new (
        session: unknown,
        channel?: EventChannelLike,
        util?: unknown,
    ) => MsgApiLike;
    GroupApi: new (session: unknown) => GroupApiLike;
    FriendApi: new (
        session: unknown,
        deps: { uidToUin: (uins: string[]) => Promise<Map<string, string>> },
    ) => FriendApiLike;
    GroupBridge: new (
        session: unknown,
        channel: EventChannelLike,
    ) => { register(): void; unregister(): void };
    FriendBridge: new (
        session: unknown,
        channel: EventChannelLike,
    ) => { register(): void; unregister(): void };
    // 批次三（2026-11-01）：RecentContact 桥（peer_pin_change 源）+ Login 桥
    //（bot_offline 源；loginService 由装配方注入 ctx.wrapper.loginService）
    RecentContactBridge: new (
        session: unknown,
        channel: EventChannelLike,
    ) => { register(): void; unregister(): void };
    LoginBridge: new (
        loginService: unknown,
        channel: EventChannelLike,
    ) => { register(): void; unregister(): void };
    GroupCache: new (options: {
        channel: EventChannelLike;
        groupApi: GroupApiLike;
    }) => {
        register(): void;
        unregister(): void;
        listGroupsRefreshed(): Promise<Array<{ groupCode: string; groupName: string }>>;
        getMember?(
            groupCode: string,
            uid: string,
        ): Promise<{ uid: string; nick?: string } | undefined>;
    };
    BuddyCache: new (options: {
        channel: EventChannelLike;
        logger?: unknown;
    }) => {
        events: EventChannelLike;
        register(): void;
        unregister(): void;
    };
    GroupNotifyApi: new (session: unknown) => GroupNotifyApiLike;
    TicketApi: new (
        session: unknown,
    ) => {
        getCookies(domain: string, uin: string): Promise<Record<string, string>>;
    };
    RichMediaApi: new (session: unknown) => unknown;
    FlashTransferApi: new (session: unknown) => unknown;
    RecentContactApi: new (session: unknown) => unknown;
    ProfileApi: new (session: unknown) => unknown;
    ProfileLikeApi: new (session: unknown) => unknown;
    WebApi: new (options: {
        getCookies: (domain: string) => Promise<Record<string, string>>;
    }) => unknown;
    PathWrapper: new (options: {
        dataRoot?: string | undefined;
        account: string;
    }) => {
        clearCache(): void;
    };
}
