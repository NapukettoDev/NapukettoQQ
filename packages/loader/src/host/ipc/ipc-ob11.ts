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
 * fail-soft：import/构造失败只 log 降级为纯 kernel 动作面，不阻断登录链路。
 */
import { join } from "node:path";
import process from "node:process";
import { isAdapterCoreModule, isNetworkModule, isOb11Module } from "../core/module-guards.js";
import { env } from "../env.js";
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
import { errMsg, log } from "../util.js";
import type { IpcActionHandler } from "./ipc-actions.js";
import { sendEvent } from "./ipc-sender.js";

/** QQ NT global 目录（get_image/get_record 的 NT 相对路径解析基准，T5）：
 * resolveQqUserDataRoot 从 wrapper util 读 QQ 用户数据根（Documents/Tencent Files）。 */
export function resolveMediaBaseDir(kernel: KernelLike, ctx: CoreContextLike): string | undefined {
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
    if (adapterEntry === undefined || adapterEntry === "") {
        return noop;
    }
    if (networkEntry === undefined || networkEntry === "") {
        return noop;
    }
    const importModule = deps.importModule ?? importFileUrl;
    const emit = deps.emitEvent ?? sendEvent;
    try {
        const { network, adapter, adapterCore } = await loadOb11BridgeModules(importModule, {
            ...e,
            adapterEntry,
            networkEntry,
        });

        const broadcaster = new network.EventBroadcaster();
        // seed 模式：load() 返回内存初值（parse({}) 缺省段），不读不写任何配置文件
        const protocolConfig = new adapterCore.ProtocolConfig({
            path: join(e.cfgDir ?? ".", "ob11-ipc.toml"),
            schema: adapter.ob11ConfigSchema,
            defaults: adapter.ob11ConfigSchema.parse({}),
            seed: adapter.ob11ConfigSchema.parse({}),
        });
        // QQ NT global 目录（get_image/get_record 的 NT 相对路径解析基准，T5）
        const mediaBaseDir = resolveMediaBaseDir(services.kernel, services.ctx);
        const ob11 = new adapter.NapukettoOneBot11Adapter({
            config: protocolConfig,
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
                    process.exit(0);
                },
                restart: async () => {
                    log("ipc-ob11: set_restart 触发，退出子进程（driver 重启）");
                    process.exit(0);
                },
            },
            groupCache: services.groupCache,
        });
        // 仅接收链路：维护 messageUnique + 灰色通知翻译；无 HTTP/WS、无心跳、无 lifecycle
        await ob11.subscribeOnly();

        // 全部动作名平铺合并（信封语义在 BaseAction.handle 内完成，永不抛）
        let mounted = 0;
        for (const name of ob11.registry.names) {
            const act = ob11.registry.get(name);
            if (act === undefined) {
                continue;
            }
            actions.set(name, (params) => act.handle(params));
            mounted++;
        }
        // registry.names 是挂载面的超集（act 缺失仅跳过挂载，delete 多删无害——
        // snake_case 与 kernel 点分命名不冲突）

        // OB11 事件 → IPC event 通道（service="ob11"，name=post_type，args=[完整事件]）
        const bridgeAdapter = {
            send: (event: unknown) => {
                const postType = isRecord(event) ? event["post_type"] : undefined;
                emit("ob11", typeof postType === "string" ? postType : "unknown", [event]);
            },
        };
        broadcaster.register(bridgeAdapter);
        log(`ipc-ob11: OB11 动作桥已挂载（${mounted} 动作，事件经 ob11 通道透出）`);
        return () => {
            broadcaster.unregister(bridgeAdapter);
            ob11.unsubscribeOnly();
            // 移除挂载的动作表条目（软重登重装配清理，2026-09-08）：
            // 重挂载前必先停旧（bootstrap-core softRelogin 顺序）
            for (const name of ob11.registry.names) {
                actions.delete(name);
            }
        };
    } catch (err) {
        // fail-soft：降级为纯 kernel 动作面（登录链路不阻断）
        log(`ipc-ob11: OB11 动作桥装配失败（降级纯 kernel 动作面）: ${errMsg(err)}`);
        return noop;
    }
}
