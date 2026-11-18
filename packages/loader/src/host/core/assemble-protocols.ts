/**
 * assemble-protocols.ts：OB11 / Satori / Kurobot / Milky 协议装配（非 IPC 模式，cli pnpm start）。
 * 2026-08-08：从 protocols.ts 拆分——protocols.ts 只留入口 + IPC 分支。
 * 2026-11-18（ADR-014 按需加载）：协议段按 PROTOCOL_KEYS 表驱动提取，adapter 子路径
 * 统一走 importSubpathModule 校验；可选协议（satori/kurobot/milky）仅在账号段非空时
 * 才 `import()` 对应子路径——未启用协议零加载、零实例化。
 */
import { join } from "node:path";
import { env } from "../env.js";
import { loadProtocolSections } from "../load-config.js";
import type {
    AdapterCoreModuleLike,
    KernelLike,
    KurobotModuleLike,
    LoginResultLike,
    MilkyModuleLike,
    NetworkModuleLike,
    SatoriModuleLike,
} from "../types.js";
import { BACKSLASH_RE, INDEX_MJS_RE, type ProtocolKey } from "../types.js";
import { ConfigError, errMsg, log } from "../util.js";
import type { KernelServices } from "./kernel-services.js";
import {
    isAdapterCoreModule,
    isKurobotModule,
    isMilkyModule,
    isNetworkModule,
    isOb11Module,
    isSatoriModule,
} from "./module-guards.js";

/**
 * 协议段 seed 校验（zod 错误 → ConfigError，2026-10-25 嵌入式退出码契约）：
 * 「必填缺失/形状非法」的本体就在这里（如 kurobot url 必填）——包装后沿
 * startProtocols → bootstrap 重抛，self-host 以 78 退出，supervisor 识别 78
 * 不再守护重启，堵死「少配协议必填项 → 子进程死循环重启」。zod issue 列表
 * 是多行 JSON，压成单行（日志单行契约）。
 */
function parseSeed(
    label: string,
    schema: { parse(input: unknown): unknown },
    section: Record<string, unknown>,
): unknown {
    try {
        return schema.parse(section);
    } catch (e) {
        const detail = errMsg(e).replace(/\s+/g, " ").trim();
        throw new ConfigError(`协议配置 ${label} 段校验失败: ${detail}`, { cause: e });
    }
}

/** 可选协议 adapter 生命周期最小面（start/stop）。 */
interface AdapterHandle {
    start(): Promise<unknown>;
    stop(): Promise<void>;
}

/** 「段存在即启用、不写不启用」：空段 = 该可选协议关闭。 */
function hasSection(section: Record<string, unknown>): boolean {
    return Object.keys(section).length > 0;
}

/** 可选协议装配的公共依赖（广播器 / 配置框架 / seed 来源 / kernel 服务）。 */
interface OptionalAssemblyDeps {
    network: NetworkModuleLike;
    adapterCore: AdapterCoreModuleLike;
    cfgFile: string;
    services: KernelServices;
}

/** Satori 装配依赖（单独成函数，避免主装配函数认知复杂度超限）。 */
interface SatoriAssemblyInput extends OptionalAssemblyDeps {
    satoriAdapter: SatoriModuleLike;
    section: Record<string, unknown>;
}

/**
 * 装配 Satori（可选协议，2026-11-10）：**段为空返回 null**——与 kurobot/milky
 * 同一范式（「段存在即启用、不写不启用」）。此前无条件装配，未配置 satori 的
 * 账号也会订阅 kernel 事件并向空传输广播。
 *
 * 与 OB11 共享 kernel apis / 消息通道 / 缓存，但**广播器独立**（协议隔离）：
 * 事件只推给 satori 自己的传输客户端，不会串到 OB11 / Milky 端口。
 */
async function assembleSatori(input: SatoriAssemblyInput): Promise<AdapterHandle | null> {
    const { section, services } = input;
    if (!hasSection(section)) {
        return null;
    }
    const broadcaster = new input.network.EventBroadcaster();
    // cacheDir 缺省：落账号目录 cache（与 OB11 download_file 同目录）
    let cacheDir = join(env.NAPUTO_CFG_DIR || ".", "cache");
    const configuredCacheDir = section["cacheDir"];
    if (typeof configuredCacheDir === "string" && configuredCacheDir !== "") {
        cacheDir = configuredCacheDir;
    }
    const config = new input.adapterCore.ProtocolConfig({
        path: input.cfgFile,
        schema: input.satoriAdapter.satoriConfigSchema,
        defaults: input.satoriAdapter.satoriConfigSchema.parse({}),
        seed: parseSeed("satori", input.satoriAdapter.satoriConfigSchema, section),
    });
    const satori = new input.satoriAdapter.NapukettoSatoriAdapter({
        config,
        broadcaster,
        msgChannel: services.channel,
        msgApi: services.msgApi,
        groupApi: services.groupApi,
        groupNotifyApi: services.groupNotifyApi,
        friendApi: services.friendApi,
        profileApi: services.profileApi,
        self: services.self,
        cacheDir,
        groupCache: services.groupCache,
    });
    await satori.start();
    log("bootstrap: satori adapter started");
    return satori;
}

/** Kurobot 装配依赖（段非空才调用）。 */
interface KurobotAssemblyInput extends OptionalAssemblyDeps {
    kurobotAdapter: KurobotModuleLike;
    section: Record<string, unknown>;
}

/**
 * 装配 Kurobot（可选，2026-09-13）：**仅当账号段非空才装配**（url 必填，空段
 * parse 会炸；「段存在即启用、不写不启用」）。作为 WS 客户端连入 KuroBot 服务端
 * （kurobot-ws），段内协议配置经 zod 校验作 seed。
 */
async function assembleKurobot(input: KurobotAssemblyInput): Promise<AdapterHandle> {
    const { section, services } = input;
    const config = new input.adapterCore.ProtocolConfig({
        path: input.cfgFile,
        schema: input.kurobotAdapter.kurobotConfigSchema,
        defaults: input.kurobotAdapter.kurobotConfigDefaults(),
        seed: parseSeed("kurobot", input.kurobotAdapter.kurobotConfigSchema, section),
    });
    const kurobot = new input.kurobotAdapter.NapukettoKurobotAdapter({
        config,
        msgChannel: services.channel,
        msgApi: services.msgApi,
        self: services.self,
        // 接收行绑定过滤（P1-7）：握手/绑定表更新时填充，未绑定频道的
        // 接收行按 [log].unboundReceive 决定是否打印
        receiveFilter: services.receiveFilter,
        // 连接生命周期 / 握手被拒等日志（pino 实例，最小面）
        logger: services.logger,
    });
    await kurobot.start();
    log("bootstrap: kurobot adapter started");
    return kurobot;
}

/** Milky 装配依赖（段非空才调用）。 */
interface MilkyAssemblyInput extends OptionalAssemblyDeps {
    milkyAdapter: MilkyModuleLike;
    section: Record<string, unknown>;
}

/**
 * 装配 Milky（P0，2026-10-28）：段 enabled=true 才生效（enabled 缺省 false =
 * 空转不占端口）。单端口 HTTP（/api + /event SSE/WS）+ WebHook。
 */
async function assembleMilky(input: MilkyAssemblyInput): Promise<AdapterHandle> {
    const { section, services } = input;
    const broadcaster = new input.network.EventBroadcaster();
    const config = new input.adapterCore.ProtocolConfig({
        path: input.cfgFile,
        schema: input.milkyAdapter.milkyConfigSchema,
        defaults: input.milkyAdapter.milkyConfigSchema.parse({}),
        seed: parseSeed("milky", input.milkyAdapter.milkyConfigSchema, section),
    });
    const milky = new input.milkyAdapter.NapukettoMilkyAdapter({
        config,
        broadcaster,
        msgChannel: services.channel,
        // P1 事件通道：群请求/邀请（Group/onGroupNotifiesUpdated）+ 好友申请
        groupChannel: services.groupChannel,
        buddyChannel: services.friendChannel,
        // 批次三事件通道：peer_pin（RecentContact）+ bot_offline（Login）
        recentContactChannel: services.recentContactChannel,
        loginChannel: services.loginChannel,
        msgApi: services.msgApi,
        groupApi: services.groupApi,
        friendApi: services.friendApi,
        profileApi: services.profileApi,
        // P1 扩面依赖（表态/票据/精华/群通知/群文件）
        profileLikeApi: services.profileLikeApi,
        ticketApi: services.ticketApi,
        webApi: services.webApi,
        groupNotifyApi: services.groupNotifyApi,
        richMediaApi: services.richMediaApi,
        flashTransferApi: services.flashTransferApi,
        recentContactApi: services.recentContactApi,
        self: services.self,
        groupCache: services.groupCache,
        qqVersion: env.NAPUTO_QQ_VERSION || "unknown",
        // 发送远程媒体 URI 的下载缓存目录（与 OB11 download_file 同目录）
        mediaDir: join(env.NAPUTO_CFG_DIR || ".", "cache"),
        logger: services.calibLogger,
    });
    await milky.start();
    log("bootstrap: milky adapter started");
    return milky;
}

/** 可选协议子模块（undefined = 段为空，未加载）。 */
interface OptionalModules {
    satori: SatoriModuleLike | undefined;
    kurobot: KurobotModuleLike | undefined;
    milky: MilkyModuleLike | undefined;
}

/** 可选协议段（键与 OptionalModules 对齐）。 */
interface OptionalSections {
    satori: Record<string, unknown>;
    kurobot: Record<string, unknown>;
    milky: Record<string, unknown>;
}

/**
 * 按装配顺序（satori → kurobot → milky）启动已启用协议，返回 handle 列表。
 * 段为空的可选协议既不会走到这里（module 未加载），也不会构造实例。
 */
async function assembleOptionalProtocols(
    deps: OptionalAssemblyDeps,
    sections: OptionalSections,
    modules: OptionalModules,
): Promise<AdapterHandle[]> {
    const handles: AdapterHandle[] = [];
    if (modules.satori !== undefined) {
        const satori = await assembleSatori({
            ...deps,
            satoriAdapter: modules.satori,
            section: sections.satori,
        });
        if (satori !== null) {
            handles.push(satori);
        }
    }
    if (modules.kurobot !== undefined) {
        handles.push(
            await assembleKurobot({
                ...deps,
                kurobotAdapter: modules.kurobot,
                section: sections.kurobot,
            }),
        );
    }
    if (modules.milky !== undefined) {
        handles.push(
            await assembleMilky({
                ...deps,
                milkyAdapter: modules.milky,
                section: sections.milky,
            }),
        );
    }
    return handles;
}

/** file:// URL 化（Windows 反斜杠转正斜杠）。 */
function toFileUrl(p: string): string {
    return `file://${p.replace(BACKSLASH_RE, "/")}`;
}

/** 动态 import network 并校验导出面。 */
async function importNetworkModule(url: string): Promise<NetworkModuleLike> {
    const raw: unknown = await import(toFileUrl(url));
    if (!isNetworkModule(raw)) {
        throw new Error(`Invalid @napuketto/network module exports at ${url}`);
    }
    return raw;
}

/**
 * 动态 import adapter 子路径并校验导出面（ADR-014：子路径导出，按需加载）。
 * 子路径名即协议键（`core` 为配置框架）；错误消息统一为
 * `Invalid @napuketto/adapter/<subpath> exports at <url>`（与逐协议手写版本逐字一致）。
 */
async function importSubpathModule<T>(
    adapterEntry: string,
    subpath: ProtocolKey | "core",
    guard: (val: unknown) => val is T,
): Promise<T> {
    const url = adapterEntry.replace(INDEX_MJS_RE, `${subpath}/index.mjs`);
    const raw: unknown = await import(toFileUrl(url));
    if (!guard(raw)) {
        throw new Error(`Invalid @napuketto/adapter/${subpath} exports at ${url}`);
    }
    return raw;
}

/** 可选协议子路径按需加载：账号段非空才 `import()`（未启用协议零加载）。 */
async function importOptionalModule<T>(
    adapterEntry: string,
    subpath: ProtocolKey,
    section: Record<string, unknown>,
    guard: (val: unknown) => val is T,
): Promise<T | undefined> {
    if (!hasSection(section)) {
        return undefined;
    }
    return await importSubpathModule(adapterEntry, subpath, guard);
}

/**
 * 装配 OB11 + Satori（+ Kurobot / Milky）适配器（登录成功后，非 IPC 模式）。
 *
 * 协议隔离（2026-11-10）：每个协议一个 EventBroadcaster，事件只推给本协议的
 * 传输客户端；可选协议（satori/kurobot/milky）一律「账号段非空才 import + 装配」。
 *
 * 返回停止函数（各适配器按装配顺序 stop：传输关闭 + 订阅清理；装配跳过时不入列）——
 * startProtocols 存入 services.stopAdapters，供未来非 IPC 软重登清理（当前软重登
 * 仅 IPC 模式有触发通道，见 relogin.ts）。
 *
 * ⚠️ 装配失败**抛出**（2026-09-08 修复）：cli 模式跑宿主就是为了 OB11/Satori
 * 服务，此处吞错会让 startProtocols 误判成功、以假 ready 留驻（内部 catch
 * 曾把 protocols.ts「装配失败返回 null 判引导失败」的意图整个短路）。
 */
export async function assembleOb11AndSatori(
    kernel: KernelLike,
    services: KernelServices,
    loginResult: LoginResultLike,
): Promise<() => Promise<void>> {
    const adapterEntry = env.NAPUTO_ADAPTER_ENTRY;
    const networkEntry = env.NAPUTO_NETWORK_ENTRY;
    if (!adapterEntry || !networkEntry) {
        log("bootstrap: NAPUTO_ADAPTER_ENTRY/NETWORK_ENTRY 未设置，跳过协议装配");
        return async () => {
            // 未装配，无资源可清
        };
    }
    try {
        const network = await importNetworkModule(networkEntry);
        // 全局 TOML 配置段：按登录账号 uin 从 accounts 取协议段作 seed
        // （2026-08-08 结构拍板：协议配置嵌在账号内；未配置协议的账号不装配对应协议）。
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
        // 协议隔离（2026-11-10）：一协议一广播器。broadcaster 是「adapter 事件 →
        // 传输客户端」的唯一出口；此前四协议共用时任一协议 emit 都会推给所有协议的
        // 客户端（OB11 的 WS 收到 Satori 的 op/body 信封，事件流不可判型）。
        // kurobot 是纯客户端出向协议（无第三方接入门面、不发协议事件），无广播器。
        const ob11Broadcaster = new network.EventBroadcaster();
        // 已启动适配器（装配顺序 ob11 → satori → kurobot → milky）：停止函数按同一
        // 顺序逐个 stop（start 成功才入列，未装配协议不产生空操作项）。
        const activeAdapters: AdapterHandle[] = [];
        const ob11Config = new adapterCore.ProtocolConfig({
            path: cfgFile,
            schema: adapter.ob11ConfigSchema,
            defaults: adapter.ob11ConfigSchema.parse({}),
            seed: parseSeed("onebot11", adapter.ob11ConfigSchema, sections.onebot11),
        });
        // QQ NT global 目录（get_image/get_record 的 NT 相对路径解析基准，T5）：
        // resolveQqUserDataRoot 从 wrapper util 读 QQ 用户数据根（Documents/Tencent Files）
        const wrapperExports = services.ctx.wrapper?.exports ?? services.ctx.exports;
        const qqRoot = kernel.resolveQqUserDataRoot?.(wrapperExports) ?? null;
        const mediaBaseDir = qqRoot !== null ? kernel.resolveQqGlobalPath?.(qqRoot) : undefined;
        const ob11 = new adapter.NapukettoOneBot11Adapter({
            config: ob11Config,
            broadcaster: ob11Broadcaster,
            msgChannel: channel,
            // OB11 request 事件源（2026-09-08）：群通知 + 好友申请推送
            groupChannel: services.groupChannel,
            friendChannel: services.friendChannel,
            // OB11 friend_add 源（B2，2026-09-08）：好友缓存快照 diff 通道
            buddyCacheEvents: services.buddyCache?.events,
            // 校准日志（loader logger 的 ob11 子 logger：module=ob11，级别随
            // [log.levels].ob11；2026-10-25 校准数据已降 debug + raw 截断）
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
            // P2-16：api/ 聚合（self + system 回调合并为一个对象）
            self: services.self,
            system: {
                appVersion: env.NAPUTO_QQ_VERSION || "unknown",
                // clean_cache：清理 kernel 数据目录缓存（PathWrapper.clearCache）
                cleanCache: async () => {
                    const paths = new kernel.PathWrapper({
                        dataRoot: env.NAPKETTO_DATA,
                        account: loginResult.uin,
                    });
                    paths.clearCache();
                },
                // download_file：缓存目录
                cacheDir: join(env.NAPUTO_CFG_DIR || ".", "cache"),
                // QQ NT global 目录（get_image/get_record 的 NT 相对路径解析基准，T5）；
                // mediaBaseDir 在 adapter 构造前解析（下方 ob11 构造处）
                ...(mediaBaseDir !== undefined ? { mediaBaseDir } : {}),
                // bot_exit / set_restart：进程控制（退出 QQ 主进程由 launcher 观察）
                exit: async () => {
                    log("bootstrap: bot_exit 触发，退出 QQ 主进程");
                    process.exit(0);
                },
                restart: async () => {
                    log("bootstrap: set_restart 触发，退出 QQ 主进程（由 launcher 重启）");
                    process.exit(0);
                },
            },
            // P2-17：群/成员缓存（ADR-008，翻译层只读消费）
            groupCache,
        });
        await ob11.start();
        log("bootstrap: onebot11 adapter started");
        activeAdapters.push(ob11);

        // 可选协议（satori → kurobot → milky）：段非空才装配（见各 assemble*）。
        // 与 OB11 共享 kernel apis / 消息通道 / 缓存，但广播器各自独立（协议隔离）。
        activeAdapters.push(
            ...(await assembleOptionalProtocols(
                { network, adapterCore, cfgFile, services },
                {
                    satori: sections.satori,
                    kurobot: sections.kurobot,
                    milky: sections.milky,
                },
                optionalModules,
            )),
        );
        return async () => {
            // 适配器 stop 幂等（started 标志守卫）：传输关闭 + kernel 事件退订
            for (const inst of activeAdapters) {
                await inst.stop();
            }
        };
    } catch (e) {
        // 抛给 startProtocols 判引导失败（见函数头注释；不再吞错 fail-soft）
        log(`bootstrap: 协议装配失败: ${errMsg(e)}`);
        throw e;
    }
}
