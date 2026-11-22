/**
 * ipc-ob11.ts：OB11 动作容器 IPC 桥（NAPUTO_IPC=1 可选装配，2026-08-27）。
 *
 * 触发条件：IPC 模式 && NAPUTO_ADAPTER_ENTRY + NAPUTO_NETWORK_ENTRY 已注入
 * （koishi 插件 launcher 透传；未注入 = app 层不要 OB11 面，静默跳过）。
 *
 * 装配：动态 import adapter onebot11/core 子路径 + network 入口（assemble-
 * protocols.ts 同款——loader 编译期零 adapter/network 静态依赖），实例化
 * NapukettoOneBot11Adapter 后仅 subscribeOnly()（接收链路，零网络传输），
 * 全部动作名平铺合并进共享 IPC 动作表（OB11 snake_case 与 kernel 点分
 * 命名空间不冲突），OB11 事件经 broadcaster 桥适配器 → sendEvent("ob11")。
 *
 * fail-soft：装配失败回滚到纯 kernel 动作面，不阻断登录链路。
 */
import { join } from "node:path";
import { isShuttingDown, requestShutdown } from "../../lifecycle/shutdown.js";
import { isAdapterCoreModule, isNetworkModule, isOb11Module } from "../core/module-guards.js";
import { env } from "../env.js";
import { loadProtocolSections, localMediaBaseDir, parseProtocolSeed } from "../load-config.js";
import { isRecord } from "../type-guards.js";
import type {
    AdapterCoreModuleLike,
    CoreContextLike,
    KernelLike,
    KernelServices,
    NetworkModuleLike,
    Ob11ModuleLike,
} from "../types.js";
import { BACKSLASH_RE, INDEX_MJS_RE } from "../types.js";
import { ConfigError, errMsg, log } from "../util.js";
import type { IpcActionHandler } from "./ipc-actions.js";
import { sendEvent } from "./ipc-sender.js";

/** QQ NT global 目录（get_image/get_record 的 NT 相对路径解析基准，T5）：
 * resolveQqUserDataRoot 从 wrapper util 读 QQ 用户数据根（Documents/Tencent Files）。 */
function resolveMediaBaseDir(kernel: KernelLike, ctx: CoreContextLike): string | undefined {
    if (ctx === undefined || ctx === null) {
        return undefined;
    }
    const wrapperExports = ctx.wrapper?.exports ?? ctx.exports;
    const qqRoot = kernel.resolveQqUserDataRoot?.(wrapperExports) ?? null;
    if (qqRoot === null) {
        return undefined;
    }
    return kernel.resolveQqGlobalPath?.(qqRoot);
}

/** 环境覆盖（缺省取全局 env；单测注入。exactOptionalPropertyTypes：显式 undefined 合法）。 */
export interface Ob11BridgeEnv {
    adapterEntry?: string | undefined;
    networkEntry?: string | undefined;
    qqVersion?: string | undefined;
    dataRoot?: string | undefined;
    cfgDir?: string | undefined;
}

/** 可注入依赖（单测用；缺省真实实现）。 */
export interface Ob11BridgeDeps {
    importModule?: (url: string) => Promise<unknown>;
    emitEvent?: (service: string, name: string, args: unknown[]) => void;
    env?: Ob11BridgeEnv;
}

/** 动态 import（file:// URL；全动态表达式，打包器不静态解析）。 */
async function importFileUrl(url: string): Promise<unknown> {
    return import(url);
}

/** OB11 桥依赖的已校验模块面。 */
interface Ob11BridgeModules {
    network: NetworkModuleLike;
    adapter: Ob11ModuleLike;
    adapterCore: AdapterCoreModuleLike;
}

/** 动态 import 并校验 network / onebot11 / core 三个模块（失败抛出）。 */
async function loadOb11BridgeModules(
    importModule: (url: string) => Promise<unknown>,
    e: Ob11BridgeEnv & { adapterEntry: string; networkEntry: string },
): Promise<Ob11BridgeModules> {
    const toUrl = (p: string): string => `file://${p.replace(BACKSLASH_RE, "/")}`;
    const rawNetwork: unknown = await importModule(toUrl(e.networkEntry));
    if (!isNetworkModule(rawNetwork)) {
        throw new Error(`Invalid @napuketto/network module exports at ${e.networkEntry}`);
    }
    // adapter 子路径导出（ADR-014）：onebot11 面 / core 框架各走各的入口
    const onebot11Entry = e.adapterEntry.replace(INDEX_MJS_RE, "onebot11/index.mjs");
    const coreEntry = e.adapterEntry.replace(INDEX_MJS_RE, "core/index.mjs");
    const rawAdapter: unknown = await importModule(toUrl(onebot11Entry));
    if (!isOb11Module(rawAdapter)) {
        throw new Error(`Invalid @napuketto/adapter/onebot11 exports at ${onebot11Entry}`);
    }
    const rawAdapterCore: unknown = await importModule(toUrl(coreEntry));
    if (!isAdapterCoreModule(rawAdapterCore)) {
        throw new Error(`Invalid @napuketto/adapter/core exports at ${coreEntry}`);
    }
    return { network: rawNetwork, adapter: rawAdapter, adapterCore: rawAdapterCore };
}

/** 确认动态载入的 adapter 认识该字段，再从主配置注入账号策略。 */
function resolveBridgeConfig(schema: Ob11ModuleLike["ob11ConfigSchema"], services: KernelServices) {
    const defaults = parseProtocolSeed("onebot11", schema, {
        media: { outboundPolicy: "public-only", localMediaRoots: [] },
    });
    if (
        !isRecord(defaults) ||
        !isRecord(defaults["media"]) ||
        defaults["media"]["outboundPolicy"] !== "public-only" ||
        !Array.isArray(defaults["media"]["localMediaRoots"])
    ) {
        throw new Error("注入的 OB11 adapter 不支持 media.outboundPolicy / media.localMediaRoots");
    }
    const { cfgFile, ob11Section } = loadProtocolSections(services.kernel, services.self.uin);
    const media = ob11Section["media"];
    const seed = media === undefined ? defaults : parseProtocolSeed("onebot11", schema, { media });
    return { defaults, seed, cfgFile };
}

function mountOb11Actions(
    registry: InstanceType<Ob11ModuleLike["NapukettoOneBot11Adapter"]>["registry"],
    actions: Map<string, IpcActionHandler>,
    mounted: string[],
): void {
    for (const name of registry.names) {
        const action = registry.get(name);
        if (action === undefined) continue;
        actions.set(name, (params) => action.handle(params));
        mounted.push(name);
    }
}

/**
 * OB11 动作桥装配（bootstrap 登录成功、attachIpcServices 之后调用）。
 * 返回停止函数（broadcaster 注销 + adapter 退订；进程级清理用）。
 */
export async function attachOb11IpcBridge(
    actions: Map<string, IpcActionHandler>,
    services: KernelServices,
    deps: Ob11BridgeDeps = {},
): Promise<() => void> {
    const e: Ob11BridgeEnv = deps.env ?? {
        adapterEntry: env.NAPUTO_ADAPTER_ENTRY,
        networkEntry: env.NAPUTO_NETWORK_ENTRY,
        qqVersion: env.NAPUTO_QQ_VERSION,
        dataRoot: env.NAPKETTO_DATA,
        cfgDir: env.NAPUTO_CFG_DIR,
    };
    const noop = (): void => {
        // 降级空操作（未注入入口 / 装配失败：保持纯 kernel 动作面）
    };
    const adapterEntry = e.adapterEntry;
    const networkEntry = e.networkEntry;
    if (isShuttingDown() || !adapterEntry || !networkEntry) {
        return noop;
    }
    const importModule = deps.importModule ?? importFileUrl;
    const emit = deps.emitEvent ?? sendEvent;
    let stop = noop;
    try {
        log("ipc-ob11: 加载 OB11 动作桥模块");
        const { network, adapter, adapterCore } = await loadOb11BridgeModules(importModule, {
            ...e,
            adapterEntry,
            networkEntry,
        });

        const schema = adapter.ob11ConfigSchema;
        const { cfgFile, ...bridgeConfig } = resolveBridgeConfig(schema, services);
        const broadcaster = new network.EventBroadcaster();
        const protocolConfig = new adapterCore.ProtocolConfig({
            path: join(e.cfgDir ?? ".", "ob11-ipc.toml"),
            schema,
            ...bridgeConfig,
        });
        // QQ NT global 目录（get_image/get_record 的 NT 相对路径解析基准，T5）
        const mediaBaseDir = resolveMediaBaseDir(services.kernel, services.ctx);
        const ob11 = new adapter.NapukettoOneBot11Adapter({
            config: protocolConfig,
            localMediaBaseDir: localMediaBaseDir(cfgFile, e.dataRoot ?? e.cfgDir),
            broadcaster,
            msgChannel: services.channel,
            // OB11 request 事件源（2026-09-08）：群通知 + 好友申请推送
            groupChannel: services.groupChannel,
            friendChannel: services.friendChannel,
            // OB11 friend_add 源（B2，2026-09-08）：好友缓存快照 diff 通道
            buddyCacheEvents: services.buddyCache?.events,
            // 校准日志（pino 实例，未知事件形状 raw JSON）
            logger: services.logger,
            msgApi: services.msgApi,
            groupApi: services.groupApi,
            groupNotifyApi: services.groupNotifyApi,
            friendApi: services.friendApi,
            ticketApi: services.ticketApi,
            richMediaApi: services.richMediaApi,
            flashTransferApi: services.flashTransferApi,
            profileApi: services.profileApi,
            profileLikeApi: services.profileLikeApi,
            webApi: services.webApi,
            self: services.self,
            system: {
                appVersion: e.qqVersion || "unknown",
                // clean_cache：清理 kernel 数据目录缓存（PathWrapper.clearCache）
                cleanCache: async () => {
                    const paths = new services.kernel.PathWrapper({
                        dataRoot: e.dataRoot,
                        account: services.self.uin,
                    });
                    paths.clearCache();
                },
                // download_file：缓存目录
                cacheDir: join(e.cfgDir ?? ".", "cache"),
                ...(mediaBaseDir !== undefined ? { mediaBaseDir } : {}),
                // bot_exit / set_restart：退出子进程，koishi 插件 driver 重启机制接管
                exit: async () => {
                    log("ipc-ob11: bot_exit 触发，退出子进程");
                    void requestShutdown("OB11 进程控制请求");
                },
                restart: async () => {
                    log("ipc-ob11: set_restart 触发，退出子进程（driver 重启）");
                    void requestShutdown("OB11 进程控制请求");
                },
            },
            groupCache: services.groupCache,
        });
        // OB11 事件 → IPC event 通道（service="ob11"，name=post_type，args=[完整事件]）
        const bridgeAdapter = {
            send: (event: unknown) => {
                const postType = isRecord(event) ? event["post_type"] : undefined;
                emit("ob11", typeof postType === "string" ? postType : "unknown", [event]);
            },
        };
        const mounted: string[] = [];
        stop = () => {
            broadcaster.unregister(bridgeAdapter);
            try {
                ob11.unsubscribeOnly();
            } finally {
                for (const name of mounted) {
                    actions.delete(name);
                }
            }
        };
        // 仅接收链路，含媒体缓存首次清理；IPC 出口等 ready 写出后才转发。
        log("ipc-ob11: 等待 OB11 接收链路初始化");
        await ob11.subscribeOnly();
        mountOb11Actions(ob11.registry, actions, mounted);
        broadcaster.register(bridgeAdapter);
        log(`ipc-ob11: OB11 动作桥已挂载（${mounted.length} 动作，事件经 ob11 通道透出）`);
        return stop;
    } catch (err) {
        try {
            stop();
        } catch (cleanupError) {
            log(`ipc-ob11: OB11 动作桥回滚失败: ${errMsg(cleanupError)}`);
        }
        if (err instanceof ConfigError) throw err;
        log(`ipc-ob11: OB11 动作桥装配失败（降级纯 kernel 动作面）: ${errMsg(err)}`);
        return noop;
    }
}
