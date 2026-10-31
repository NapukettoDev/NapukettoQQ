/**
 * wrapper.node 的 NAPI 接口面（自研描述，非移植）
 *
 * 来源：wrapper.node 在 QQ 定制版 Electron 里通过 napi_define_class / napi_set_named_property
 * 注册的 JS 类（2026-08-05 Ghidra 反编译 FUN_180c6274a / FUN_180c80224 确认类名）。
 * 这些接口是 wrapper.node 对外暴露的外部系统契约——我们自研描述其形状，未复制任何第三方代码。
 *
 * 注意：这里所有对象由 QQ 运行时的 NAPI 层自动构建/转换，业务层禁止触碰 C++ ABI。
 */

/** 平台类型（与 wrapper.node 的 platform 字段对应）。 */
export const PlatformType = {
    KUNKNOWN: 0,
    KANDROID: 1,
    KIOS: 2,
    KWINDOWS: 3,
    KMAC: 4,
    KLINUX: 5,
} as const;
export type PlatformType = (typeof PlatformType)[keyof typeof PlatformType];

/** 厂商类型（deviceInfo.vendorType）。 */
export const VendorType = {
    KNOSETONIOS: 0,
    KUNSUPPORTANDROIDPUSH: 1,
    KSUPPORTTPNS: 2,
    KSUPPORTHMS: 3,
    KSUPPORTOPPOPUSH: 4,
    KSUPPORTVIVOPUSH: 5,
    KSUPPORTGOOGLEPUSH: 99,
} as const;
export type VendorType = (typeof VendorType)[keyof typeof VendorType];

/** NodeQQNTWrapperUtil：通用工具类（静态服务）。 */
export interface NodeQQNTWrapperUtil {
    get(): NodeQQNTWrapperUtil;
    getNTUserDataInfoConfig(): string;
    // 文件/哈希工具（按需补齐，运行时反射枚举为准）
    getFileSize(path: string): Promise<number>;
    fileIsExist(path: string): unknown;
    makeDirByPath(path: string): unknown;
}

/** engine 初始化配置（initWithDeskTopConfig 第一参，JS 对象直接传）。 */
export interface EnginInitDesktopConfig {
    base_path_prefix: string;
    platform_type: PlatformType;
    /** 桌面端应用类型（engine.initWithDeskTopConfig 契约，桌面端固定 4；移动端为其它值）。 */
    app_type: 4;
    app_version: string;
    os_version: string;
    use_xlog: boolean;
    qua: string;
    global_path_config: {
        desktopGlobalPath: string;
    };
    /**
     * 缩略图生成参数（wrapper 契约）：maxSide 最长边上限 / minSide 最短边下限 /
     * longLimit 长图最长短边比例上限 / density 像素密度倍数。
     */
    thumb_config: { maxSide: 324; minSide: 48; longLimit: 6; density: 2 };
}

/** NodeIQQNTWrapperEngine 实例方法。 */
export interface NodeIQQNTWrapperEngine {
    initWithDeskTopConfig(config: EnginInitDesktopConfig, adapter: NodeIGlobalAdapter): void;
    initWithMobileConfig(config: unknown, adapter: NodeIGlobalAdapter): void;
    initLog(arg: unknown): void;
    setLogLevel(arg: unknown): void;
    onSendSSOReply(a: unknown, b: unknown, c: unknown, d: unknown, e: unknown): void;
}

/** NodeIQQNTWrapperEngine 构造器（含静态 get()）。 */
export type NodeIQQNTWrapperEngineCtor = new () => NodeIQQNTWrapperEngine & {
    get(): NodeIQQNTWrapperEngine;
};

/** desktopPathConfig 结构。 */
export interface DesktopPathConfig {
    account_path: string;
}

/** rdeliveryConfig 结构。 */
export interface RDeliveryConfig {
    appKey: string;
    systemId: number;
    appId: string;
    logicEnvironment: string;
    platform: PlatformType;
    language: string;
    sdkVersion: string;
    userId: string;
    appVersion: string;
    osVersion: string;
    bundleId: string;
    serverUrl: string;
    fixedAfterHitKeys: string[];
}

/** deviceInfo 结构。 */
export interface DeviceInfo {
    guid: string;
    buildVer: string;
    localId: number;
    devName: string;
    devType: string;
    vendorName: string;
    osVer: string;
    vendorOsName: string;
    setMute: boolean;
    vendorType: VendorType;
}

/** session.init 的完整配置（JS 对象，NAPI 自动转换）。 */
export interface WrapperSessionInitConfig {
    selfUin: string;
    selfUid: string;
    desktopPathConfig: DesktopPathConfig;
    clientVer: string;
    a2: string;
    d2: string;
    d2Key: string;
    machineId: string;
    platform: PlatformType;
    platVer: string;
    appid: string;
    rdeliveryConfig: RDeliveryConfig;
    defaultFileDownloadPath: string;
    deviceInfo: DeviceInfo;
    deviceConfig: string;
}

/** NodeIQQNTWrapperSession 构造器（含静态 get / getNTWrapperSession / create）。 */
export type NodeIQQNTWrapperSessionCtor = {
    new (): NodeIQQNTWrapperSession;
    get(): NodeIQQNTWrapperSession;
    getNTWrapperSession(name: string): NodeIQQNTWrapperSession;
    create(): NodeIQQNTWrapperSession;
};

/** NodeIQQNTWrapperSession：会话主入口（实例方法）。 */
export interface NodeIQQNTWrapperSession {
    init(
        config: WrapperSessionInitConfig,
        depends: NodeIDependsAdapter,
        dispatcher: NodeIDispatcherAdapter,
        listener: NodeIKernelSessionListener,
    ): void;
    startNT(sessionId?: number): void;
    close(arg: unknown): void;
    onLine(arg: unknown): void;
    offLine(arg: unknown): void;
    disableIpDirect(arg: unknown): void;
    getAccountPath(arg: unknown): string;
    updateTicket(arg: unknown): void;
    // 60+ getService：运行时反射枚举后补齐
    getMsgService(): unknown;
    getGroupService(): unknown;
    getBuddyService(): unknown;
    getTicketService(): unknown;
    getRichMediaService(): unknown;
    /** 闪传服务（诊断用：调查 rich media transfer failed 时验证初始化触发点）。 */
    getFlashTransferService(): unknown;
    getProfileService(): unknown;
    /** 会话列表（P2 批次二 get_peer_pins 数据源；2026-10-31 探测方法面）。 */
    getRecentContactService(): unknown;
    getProfileLikeService(): unknown;
    getTipOffService(): unknown;
}

/** NodeIQQNTStartupSessionWrapper：启动会话实例方法。 */
export interface NodeIQQNTStartupSessionWrapper {
    stop(): void;
    start(): void;
    createWithModuleList(uk: unknown): unknown;
    getSessionIdList(): Promise<Map<unknown, unknown>>;
}

/** NodeIQQNTStartupSessionWrapper 构造器（含静态 create）。 */
export type NodeIQQNTStartupSessionWrapperCtor = new () => NodeIQQNTStartupSessionWrapper & {
    create(): NodeIQQNTStartupSessionWrapper;
};

/** NodeIKernelLoginService 实例方法。 */
export interface NodeIKernelLoginService {
    addKernelLoginListener(listener: unknown): number;
    removeKernelLoginListener(listener: number): void;
    initConfig(config: unknown): void;
    connect(): void;
    getLoginList(): Promise<{ result: number; LocalLoginInfoList: unknown[] }>;
    quickLoginWithUin(uin: string): Promise<unknown>;
    getQRCodePicture(): boolean;
    getMsfStatus(): number;
    /** 设备指纹 guid（wrapper.node 字符串分析实证，2026-08-12；无 getMachineId）。 */
    getMachineGuid(): string;
}

/** NodeIKernelLoginService 构造器（含静态 get）。 */
export type NodeIKernelLoginServiceCtor = new () => NodeIKernelLoginService & {
    get(): NodeIKernelLoginService;
};

/** NodeIO3MiscService：O3 杂项服务。 */
export interface NodeIO3MiscService {
    get(): NodeIO3MiscService;
    addO3MiscListener(listener: unknown): number;
}

// adapter 类型（session.init 第二/三参、engine.initWithDeskTopConfig 第二参）
// 注意：wrapper exports **不含** NodeI*Adapter / NodeI*Listener 构造器（实测 89 键无）。
// 传普通 JS 对象即可——NAPI 反射读取对象上的方法回调。方法名是 QQ wrapper 的外部契约
//（2026-08-05 运行时行为实测确认，接口为自研描述）。
export interface NodeIGlobalAdapter {
    onLog?(...args: unknown[]): void;
    onGetSrvCalTime?(...args: unknown[]): void;
    onShowErrUITips?(...args: unknown[]): void;
    fixPicImgType?(...args: unknown[]): unknown;
    getAppSetting?(...args: unknown[]): unknown;
    onInstallFinished?(...args: unknown[]): void;
    onUpdateGeneralFlag?(...args: unknown[]): void;
    onGetOfflineMsg?(...args: unknown[]): void;
}

/** session.init 第二参：依赖回调（普通 JS 对象）。 */
export interface NodeIDependsAdapter {
    onMSFStatusChange?(statusType: number, changeReasonType: number): void;
    onMSFSsoError?(code: number, desc: string): void;
    getGroupCode?(...args: unknown[]): unknown;
}

/** session.init 第三参：请求分发回调（普通 JS 对象）。 */
export interface NodeIDispatcherAdapter {
    dispatchRequest?(arg: unknown): void;
    dispatchCall?(arg: unknown): void;
    dispatchCallWithJson?(arg: unknown): void;
}

/** 登录监听器接口（普通 JS 对象，传给 loginService.addKernelLoginListener）。自研描述。 */
export interface IKernelLoginListener {
    onLoginConnected?(...args: unknown[]): void;
    onLoginDisConnected?(...args: unknown[]): void;
    onLoginConnecting?(...args: unknown[]): void;
    onQRCodeGetPicture?(arg: { pngBase64QrcodeData: string; qrcodeUrl: string }): void;
    onQRCodeLoginPollingStarted?(...args: unknown[]): void;
    onQRCodeSessionUserScaned?(...args: unknown[]): void;
    onQRCodeLoginSucceed?(loginResult: { uid: string; uin: string; nick?: string }): void;
    onQRCodeSessionFailed?(errType: number, errCode: number, errMsg: string): void;
    onLoginFailed?(args: unknown): void;
    onLogoutSucceed?(...args: unknown[]): void;
    onLogoutFailed?(...args: unknown[]): void;
    onUserLoggedIn?(userid: string): void;
    onQRCodeSessionQuickLoginFailed?(...args: unknown[]): void;
    onPasswordLoginFailed?(...args: unknown[]): void;
    onQQLoginNumLimited?(...args: unknown[]): void;
    onLoginState?(...args: unknown[]): void;
}

/**
 * NodeIKernelSessionListener：session.init 第四参监听器（普通 JS 对象）。
 * init 完成信号：以 onOpentelemetryInit(is_init===true) 为准（onSessionInitComplete 为辅）。
 */
export interface NodeIKernelSessionListener {
    onNTSessionCreate?(sessionId: string): void;
    onGProSessionCreate?(sessionId: string): void;
    onSessionInitComplete?(result: unknown): void;
    onOpentelemetryInit?(info: { is_init: boolean; is_report: boolean }): void;
    onUserOnlineResult?(result: unknown): void;
    onGetSelfTinyId?(result: unknown): void;
}

/** wrapper.node 的 NAPI 顶层导出（module.exports）。 */
export interface WrapperNodeApi {
    NodeIO3MiscService: NodeIO3MiscService;
    NodeQQNTWrapperUtil: NodeQQNTWrapperUtil;
    /** 构造器：`new wrapper.NodeIQQNTWrapperSession()`。 */
    NodeIQQNTWrapperSession: NodeIQQNTWrapperSessionCtor;
    NodeIQQNTStartupSessionWrapper: NodeIQQNTStartupSessionWrapperCtor;
    /** 构造器：`new wrapper.NodeIQQNTWrapperEngine()`。 */
    NodeIQQNTWrapperEngine: NodeIQQNTWrapperEngineCtor;
    /** 构造器：`new wrapper.NodeIKernelLoginService()`。 */
    NodeIKernelLoginService: NodeIKernelLoginServiceCtor;
    // 注：wrapper exports **不含** NodeI*Adapter / NodeI*Listener 构造器（实测 89 键无）——
    // adapter/listener 一律传普通 JS 对象（见 NodeIGlobalAdapter 等接口）。
}
