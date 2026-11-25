/**
 * wrapper 域共享类型（纯类型声明）：`WrapperContext` 是装配根持有的 wrapper 句柄，
 * 跨 core / login / probe / bridge 使用；由 `lifecycle.ts` 重新导出，import 坐标不变。
 */
import type {
    EnginInitDesktopConfig,
    NodeIKernelLoginService,
    NodeIQQNTStartupSessionWrapper,
    NodeIQQNTWrapperEngine,
    NodeIQQNTWrapperSession,
    WrapperNodeApi,
    WrapperSessionInitConfig,
} from "../../types/index.js";
import type { BootEnv } from "./loader.js";

/** QQ 版本信息（登录握手用）。 */
export interface QqVersionContext {
    fullVersion: string;
    buildVersion: string;
}

/** @deprecated 使用 `QqVersionContext`（缩写大小写统一为 `Qq`）。 */
export type QQVersionContext = QqVersionContext;

/** 已引导的 wrapper 上下文（运行在 QQ Electron 主进程内）。 */
export interface WrapperContext {
    /** wrapper.node 的 NAPI 顶层导出。 */
    exports: WrapperNodeApi;
    /** engine 单例（get() 已调用）。 */
    engine: NodeIQQNTWrapperEngine;
    /** 版本信息（供登录握手等使用）。 */
    versionInfo: QqVersionContext;
    /** 会话（QQ 拦截捕获 / createSession 后填充）。 */
    session: NodeIQQNTWrapperSession | null;
    /** 启动会话包装（NapCat 同款：StartupSessionWrapper.create()，start() 替代 startNT）。 */
    startupSession: NodeIQQNTStartupSessionWrapper | null;
    /**
     * QQ 的 loginService 实例（拦截 new 捕获，可为 null）。
     * 保留 `unknown` 联合以兼容测试桩与老版本 wrapper（仅按方法名反射调用）。
     */
    loginService: NodeIKernelLoginService | unknown;
    /** wrapper.node 绝对路径（BootEnv.wrapperPath 注入；appid 自动解析用）。 */
    wrapperPath?: string | undefined;
}

/** startNapuketto 选项。 */
export interface StartNapukettoOptions {
    /** 截获的 wrapper.node NAPI exports（boot.cjs 传入）。 */
    wrapperExports: WrapperNodeApi;
    /** 引导环境（版本/数据目录/账号）。 */
    env?: BootEnv | undefined;
    /** 覆盖 engine 配置（联调用）。 */
    engineConfig?: EnginInitDesktopConfig | undefined;
    /** 覆盖 session 配置（联调用，提供则自动 init+start）。 */
    sessionConfig?: WrapperSessionInitConfig | undefined;
    /** QQ 已 init 的 session（boot.cjs 拦截 new 捕获）。 */
    qqSession?: NodeIQQNTWrapperSession | null | undefined;
    /** QQ 的 loginService 实例（boot.cjs 拦截 new 捕获）。 */
    qqLoginService?: unknown;
}
