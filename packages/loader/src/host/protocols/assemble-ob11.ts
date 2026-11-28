/**
 * assemble-ob11.ts：非 IPC 模式（cli）的 OB11 主装配与协议编排。
 * 协议段按 PROTOCOL_KEYS 表驱动提取，adapter 子路径统一走 importSubpathModule 校验；可选协议（satori/kurobot/milky）
 * 仅在账号段非空时才 `import()` 对应子路径——未启用协议零加载、零实例化（构造见 optional.ts）。
 */
import { join } from "node:path";
import {
    registerShutdownHook,
    requestShutdown,
    runShutdownHook,
} from "../../lifecycle/shutdown.js";
import { log } from "../../shared/boot-log.js";
import { getErrorMessage } from "../../shared/type-guards.js";
import { env } from "../runtime/env.js";
import {
    loadProtocolSections,
    localMediaBaseDir,
    parseProtocolSeed,
} from "../runtime/load-config.js";
import {
    isAdapterCoreModule,
    isKurobotModule,
    isMilkyModule,
    isOb11Module,
    isSatoriModule,
} from "../runtime/module-guards.js";
import {
    importNetworkModule,
    importOptionalModule,
    importSubpathModule,
} from "../runtime/module-loader.js";
import type { KernelLike, LoginResultLike } from "../runtime/types.js";
import type { KernelServices } from "./kernel-services.js";
import {
    type AdapterHandle,
    assembleOptionalProtocols,
    type OptionalModules,
    startAdapter,
    stopAdapters,
} from "./optional.js";

/**
 * 装配 OB11 + Satori（+ Kurobot / Milky）适配器（登录成功后，非 IPC 模式）。
 *
 * 协议隔离：每个协议一个 EventBroadcaster，事件只推给本协议的
 * 传输客户端；可选协议（satori/kurobot/milky）一律「账号段非空才 import + 装配」。
 *
 * 返回停止函数（各适配器按装配顺序 stop：传输关闭 + 订阅清理；装配跳过时不入列）——
 * startProtocols 存入 services.stopAdapters，供未来非 IPC 软重登清理（当前软重登
 * 仅 IPC 模式有触发通道，见 relogin.ts）。
 *
 * ⚠️ 装配失败**抛出**：cli 模式跑宿主就是为了 OB11/Satori
 * 服务，此处吞错会让 startProtocols 误判成功、以假 ready 留驻（内部 catch
 * 会短路 protocols.ts「装配失败返回 null 判引导失败」的意图）。
 */
export async function assembleOb11AndSatori(
    kernel: KernelLike,
    services: KernelServices,
    loginResult: LoginResultLike,
): Promise<() => Promise<void>> {
    const adapterEntry = env.NAPUKETTO_ADAPTER_ENTRY;
    const networkEntry = env.NAPUKETTO_NETWORK_ENTRY;
    if (!adapterEntry || !networkEntry) {
        log("bootstrap: NAPUKETTO_ADAPTER_ENTRY/NETWORK_ENTRY 未设置，跳过协议装配");
        return async () => {
            // 未装配，无资源可清
        };
    }
    const activeAdapters: AdapterHandle[] = [];
    let stopping: Promise<void> | undefined;
    const stop = () => (stopping ??= stopAdapters(activeAdapters));
    const unregisterShutdown = registerShutdownHook(stop, "protocols");
    try {
        const network = await importNetworkModule(networkEntry);
        // 全局 TOML 配置段：按登录账号 uin 从 accounts 取协议段作 seed
        // （协议配置嵌在账号内；未配置协议的账号不装配对应协议）。
        const { cfgFile, sections } = loadProtocolSections(kernel, loginResult.uin);
        // adapter 子路径导出（ADR-014）：onebot11 与 core 是主路径必载面。
        const adapter = await importSubpathModule(adapterEntry, "onebot11", isOb11Module);
        const adapterCore = await importSubpathModule(adapterEntry, "core", isAdapterCoreModule);
        // 可选协议：段非空才 import 子路径（未启用协议零加载）；先于任何 start 完成
        // 校验，导入失败时没有已启动实例需要回收。
        const optionalModules: OptionalModules = {
            satori: await importOptionalModule(
                adapterEntry,
                "satori",
                sections.satori,
                isSatoriModule,
            ),
            kurobot: await importOptionalModule(
                adapterEntry,
                "kurobot",
                sections.kurobot,
                isKurobotModule,
            ),
            milky: await importOptionalModule(adapterEntry, "milky", sections.milky, isMilkyModule),
        };

        const { channel, groupCache } = services;
        // 协议隔离：一协议一广播器。broadcaster 是「adapter 事件 →
        // 传输客户端」的唯一出口；共用时任一协议 emit 都会推给所有协议的
        // 客户端（OB11 的 WS 收到 Satori 的 op/body 信封，事件流不可判型）。
        // kurobot 是纯客户端出向协议（无第三方接入门面、不发协议事件），无广播器。
        const ob11Broadcaster = new network.EventBroadcaster();
        const ob11Config = new adapterCore.ProtocolConfig({
            path: cfgFile,
            schema: adapter.ob11ConfigSchema,
            defaults: adapter.ob11ConfigSchema.parse({}),
            seed: parseProtocolSeed("onebot11", adapter.ob11ConfigSchema, sections.onebot11),
        });
        // QQ NT global 目录（get_image/get_record 的 NT 相对路径解析基准）：
        // resolveQqUserDataRoot 从 wrapper util 读 QQ 用户数据根（Documents/Tencent Files）
        const mediaBaseDir = services.mediaBaseDir();
        const ob11 = new adapter.NapukettoOneBot11Adapter({
            config: ob11Config,
            localMediaBaseDir: localMediaBaseDir(
                cfgFile,
                env.NAPUKETTO_DATA ?? env.NAPUKETTO_CFG_DIR,
            ),
            broadcaster: ob11Broadcaster,
            msgChannel: channel,
            // OB11 request 事件源：群通知 + 好友申请推送
            groupChannel: services.groupChannel,
            friendChannel: services.friendChannel,
            // OB11 friend_add 源：好友缓存快照 diff 通道
            buddyCacheEvents: services.buddyCache?.events,
            // 校准日志（loader logger 的 ob11 子 logger：module=ob11，级别随
            // [log.levels].ob11；校准数据降 debug + raw 截断）
            logger: services.calibLogger,
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
            // api/ 聚合（self + system 回调合并为一个对象）
            self: services.self,
            system: {
                appVersion: env.NAPUKETTO_QQ_VERSION || "unknown",
                // clean_cache：清理 kernel 数据目录缓存（PathWrapper.clearCache）
                cleanCache: async () => {
                    const paths = new kernel.PathWrapper({
                        dataRoot: env.NAPUKETTO_DATA,
                        account: loginResult.uin,
                    });
                    paths.clearCache();
                },
                // download_file：缓存目录
                cacheDir: join(env.NAPUKETTO_CFG_DIR || ".", "cache"),
                // QQ NT global 目录（get_image/get_record 的 NT 相对路径解析基准）；
                // mediaBaseDir 在 adapter 构造前解析（下方 ob11 构造处）
                ...(mediaBaseDir !== undefined ? { mediaBaseDir } : {}),
                // bot_exit / set_restart：进程控制（退出 QQ 主进程由 launcher 观察）
                exit: async () => {
                    log("bootstrap: bot_exit 触发，退出 QQ 主进程");
                    void requestShutdown("OB11 进程控制请求");
                },
                restart: async () => {
                    log("bootstrap: set_restart 触发，退出 QQ 主进程（由 launcher 重启）");
                    void requestShutdown("OB11 进程控制请求");
                },
            },
            // 群/成员缓存（ADR-008，翻译层只读消费）
            groupCache,
        });
        await startAdapter(activeAdapters, ob11, "onebot11");
        await assembleOptionalProtocols(
            { kernel, network, adapterCore, cfgFile, services, mediaBaseDir },
            {
                satori: sections.satori,
                kurobot: sections.kurobot,
                milky: sections.milky,
            },
            optionalModules,
            activeAdapters,
        );
        return stop;
    } catch (e) {
        // 抛给 startProtocols 判引导失败（见函数头注释；不再吞错 fail-soft）
        log(`bootstrap: 协议装配失败: ${getErrorMessage(e)}`);
        await runShutdownHook(stop, "protocols");
        throw e;
    } finally {
        unregisterShutdown();
    }
}
