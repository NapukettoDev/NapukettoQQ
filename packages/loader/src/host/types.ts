/**
 * types.ts：自建宿主引导的类型层（2026-08-07 阶段 2 新增）。
 *
 * 与 @napuketto/kernel 的最小交互面（KernelLike 等）——自研描述，避免包级依赖：
 * loader 运行时通过 file:// 动态 import kernel，编译期不建立 workspace 依赖，
 * 因此这里用「最小接口」描述 kernel 的契约（类型层自研，与 kernel 实现解耦，
 * 由运行时行为实证维护，勿臆造成员）。
 */
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
}

/** 群 API 最小面（uin↔uid 双向映射）。 */
export interface GroupApiLike {
    uidToUin(uins: string[]): Promise<Map<string, string>>;
    uinToUid(uins: string[]): Promise<Map<string, string>>;
}

/** 消息 API 最小面。 */
export interface MsgApiLike {
    sendMessage(
        peer: { chatType: number; peerUid: string },
        elements: CanonicalElementLike[],
    ): Promise<{ msgId: string }>;
    fetchMessages(peer: unknown, options: { count: number }): Promise<RawMessageLike[]>;
    /** 设置在线状态（自建宿主无 UI，引导链必须显式上报——缺它 = 半在线无推送，2026-09-15 发现 I）。 */
    setOnlineStatus(opts: {
        status: number;
        extStatus: number;
        batteryStatus: number;
        customStatus?: { faceId: string; wording: string; faceType: string };
    }): Promise<void>;
}

/** 原始消息（kernel RawMessage 最小面，字段宽松——运行时反射实证）。 */
export interface RawMessageLike {
    chatType?: unknown;
    sendNickName?: unknown;
    senderUin?: unknown;
    peerName?: unknown;
    peerUin?: unknown;
    msgId?: unknown;
    msgSeq?: unknown;
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
    session: unknown;
    engine?: unknown;
    login?: { uin?: string; uid?: string; nick?: string };
    /** 老 kernel 回退路径（startNapuketto 手工 lifecycle）。 */
    loginService?: { initConfig(config: unknown): void };
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

/**
 * 与 @napuketto/kernel 的最小交互面。
 * 可选成员 = 老 kernel 兼容路径（startNapuketto/quickLogin 等回退分支）；
 * 必选成员 = 自建宿主主路径（2026-08-07 实测）必须存在。
 */
export interface KernelLike {
    // 装配层
    NapukettoCore?: {
        create(options: {
            paths: { dataRoot?: string | undefined };
            logLevel?: string | undefined;
            /** IPC 模式传 false：stdout 专用于 JSON 行协议，console 流会撕裂协议行。 */
            consoleLog?: boolean;
        }): CoreLike;
    };
    startNapuketto?: (options: {
        wrapperExports: unknown;
        env: Record<string, unknown>;
    }) => CoreContextLike;
    // 登录
    listLoginAccounts(ctx: CoreContextLike): Promise<LoginAccountLike[]>;
    quickLogin?: (ctx: CoreContextLike, options: unknown) => Promise<LoginResultLike>;
    buildLoginConfig?: (appid: number, version: string, dataDir: string) => unknown;
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
    resolveQqUserDataRoot?: (wrapperExports: unknown) => string | null;
    resolveQqGlobalPath?: (qqDataRoot: string) => string;
    // 探测
    probeRuntime?: (ctx: CoreContextLike, filename?: string) => ProbeResultLike;
    // 消息 / 桥 / 服务
    // ChatType 是 kernel 常量对象（GROUP/C2C），Record 字面量键规避 useNamingConvention
    ChatType: Record<"GROUP" | "C2C", number>;
    toCanonicalElements(msg: unknown): CanonicalElementLike[];
    parseToml(raw: string): Record<string, unknown>;
    // 日志（ADR-007）：kernel createLogger，loader 引导进程自建实例
    // （IPC 模式 console:false + file 落盘——stdout 专用于 JSON 行协议）
    createLogger?: (opts: {
        level?: string;
        console?: boolean;
        file?: string;
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
    ) => unknown;
    GroupBridge: new (
        session: unknown,
        channel: EventChannelLike,
    ) => { register(): void; unregister(): void };
    FriendBridge: new (
        session: unknown,
        channel: EventChannelLike,
    ) => { register(): void; unregister(): void };
    GroupCache: new (options: {
        channel: EventChannelLike;
        groupApi: GroupApiLike;
    }) => { register(): void; unregister(): void };
    BuddyCache: new (options: {
        channel: EventChannelLike;
        logger?: unknown;
    }) => {
        events: EventChannelLike;
        register(): void;
        unregister(): void;
    };
    GroupNotifyApi: new (session: unknown) => unknown;
    TicketApi: new (
        session: unknown,
    ) => {
        getCookies(domain: string, uin: string): Promise<Record<string, string>>;
    };
    RichMediaApi: new (session: unknown) => unknown;
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
