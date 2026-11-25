/**
 * ob11-bridge.ts：OB11 动作容器 IPC 桥（IPC 模式 + ADAPTER_ENTRY / NETWORK_ENTRY 都已注入才装配）。
 * 动态 import adapter onebot11/core 与 network 后实例化适配器，仅 subscribeOnly()（接收链路、零网络传输），动作名平铺并入共享动作表。
 * OB11 事件经 broadcaster 桥适配器 → sendEvent("ob11")；装配失败回滚到纯 kernel 动作面（fail-soft，ConfigError 例外上抛）。
 */
import { join } from "node:path";
import { isShuttingDown, requestShutdown } from "../../lifecycle/shutdown.js";
import { log } from "../../shared/boot-log.js";
import { getErrorMessage, isRecord } from "../../shared/type-guards.js";
import { env } from "../runtime/env.js";
import { ConfigError } from "../runtime/errors.js";
import {
    loadProtocolSections,
    localMediaBaseDir,
    parseProtocolSeed,
} from "../runtime/load-config.js";
import { importFileUrl, loadOb11BridgeModules } from "../runtime/module-loader.js";
import type { Ob11ModuleLike } from "../runtime/protocol-types.js";
import type { KernelServices } from "../runtime/service-types.js";
import type { CoreContextLike, KernelLike } from "../runtime/types.js";
import type { IpcActionHandler } from "./actions.js";
import { sendEvent } from "./sender.js";

/** QQ NT global 目录（get_image/get_record 的 NT 相对路径解析基准）：
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
        adapterEntry: env.NAPUKETTO_ADAPTER_ENTRY,
        networkEntry: env.NAPUKETTO_NETWORK_ENTRY,
        qqVersion: env.NAPUKETTO_QQ_VERSION,
        dataRoot: env.NAPUKETTO_DATA,
        cfgDir: env.NAPUKETTO_CFG_DIR,
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
        // QQ NT global 目录（get_image/get_record 的 NT 相对路径解析基准）
        const mediaBaseDir = resolveMediaBaseDir(services.kernel, services.ctx);
        const ob11 = new adapter.NapukettoOneBot11Adapter({
            config: protocolConfig,
            localMediaBaseDir: localMediaBaseDir(cfgFile, e.dataRoot ?? e.cfgDir),
            broadcaster,
            msgChannel: services.channel,
            // OB11 request 事件源：群通知 + 好友申请推送
            groupChannel: services.groupChannel,
            friendChannel: services.friendChannel,
            // OB11 friend_add 源：好友缓存快照 diff 通道
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
            log(`ipc-ob11: OB11 动作桥回滚失败: ${getErrorMessage(cleanupError)}`);
        }
        if (err instanceof ConfigError) throw err;
        log(`ipc-ob11: OB11 动作桥装配失败（降级纯 kernel 动作面）: ${getErrorMessage(err)}`);
        return noop;
    }
}
