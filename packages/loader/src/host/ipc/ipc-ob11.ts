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
import type { KernelServices } from "../core/kernel-services.js";
import { env } from "../env.js";
import type { CoreContextLike, KernelLike } from "../types.js";
import { errMsg, log } from "../util.js";
import type { IpcActionHandler } from "./ipc-actions.js";
import { sendEvent } from "./ipc-sender.js";

/** Windows 反斜杠（file:// URL 化时替换）。 */
const BACKSLASH_RE = /\\/g;
/** adapter 入口 index.mjs 后缀（子路径导出替换用）。 */
const INDEX_MJS_RE = /index\.mjs$/;

/** QQ NT global 目录（get_image/get_record 的 NT 相对路径解析基准，T5）：
 * resolveQqUserDataRoot 从 wrapper util 读 QQ 用户数据根（Documents/Tencent Files）。 */
export function resolveMediaBaseDir(kernel: KernelLike, ctx: CoreContextLike): string | undefined {
    if (ctx === undefined || ctx === null) {
        return undefined;
    }
    const wrapperExports = (ctx as unknown as { wrapper?: { exports?: unknown } | null }).wrapper
        ?.exports;
    const qqRoot = kernel.resolveQqUserDataRoot?.(wrapperExports) ?? null;
    if (qqRoot === null) {
        return undefined;
    }
    return kernel.resolveQqGlobalPath?.(qqRoot);
}

/** network 包最小面（@napuketto/network，动态 import）。 */
interface NetworkModuleLike {
    EventBroadcaster: new () => {
        register(adapter: { send: <T>(payload: T) => void }): unknown;
        unregister(adapter: { send: <T>(payload: T) => void }): void;
    };
}

/** OB11 动作最小面（handle 返回 OB11 信封 {status,retcode,data,message}，永不抛）。 */
interface Ob11ActionLike {
    handle(payload: unknown): Promise<unknown>;
}

/** adapter 包 onebot11 子路径最小面（@napuketto/adapter，动态 import）。 */
interface Onebot11ModuleLike {
    ob11ConfigSchema: { parse(input: unknown): unknown };
    NapukettoOneBot11Adapter: new (
        options: Record<string, unknown>,
    ) => {
        subscribeOnly(): Promise<void>;
        unsubscribeOnly(): void;
        registry: {
            names: string[];
            get(name: string): Ob11ActionLike | undefined;
        };
    };
}

/** adapter 包 core 子路径最小面（ProtocolConfig 框架）。 */
interface AdapterCoreModuleLike {
    ProtocolConfig: new (options: Record<string, unknown>) => unknown;
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
    if (e.adapterEntry === undefined || e.adapterEntry === "") {
        return noop;
    }
    if (e.networkEntry === undefined || e.networkEntry === "") {
        return noop;
    }
    const importModule = deps.importModule ?? importFileUrl;
    const emit = deps.emitEvent ?? sendEvent;
    try {
        const toUrl = (p: string): string => `file://${p.replace(BACKSLASH_RE, "/")}`;
        const network = (await importModule(toUrl(e.networkEntry))) as NetworkModuleLike;
        // adapter 子路径导出（ADR-014）：onebot11 面 / core 框架各走各的入口
        const onebot11Entry = e.adapterEntry.replace(INDEX_MJS_RE, "onebot11/index.mjs");
        const coreEntry = e.adapterEntry.replace(INDEX_MJS_RE, "core/index.mjs");
        const adapter = (await importModule(toUrl(onebot11Entry))) as Onebot11ModuleLike;
        const adapterCore = (await importModule(toUrl(coreEntry))) as AdapterCoreModuleLike;

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
            buddyCacheEvents: (services.buddyCache as { events: unknown } | undefined)?.events,
            // 校准日志（pino 实例，未知事件形状 raw JSON）
            logger: services.logger as
                | { warn(obj: unknown, msg?: string): void; info(obj: unknown, msg?: string): void }
                | undefined,
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
                const postType = (event as { post_type?: unknown }).post_type;
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
