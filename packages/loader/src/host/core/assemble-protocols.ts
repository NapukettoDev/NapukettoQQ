/**
 * assemble-protocols.ts：OB11 / Satori 协议装配（非 IPC 模式，cli pnpm start）。
 * 2026-08-08：从 protocols.ts 拆分——protocols.ts 只留入口 + IPC 分支。
 */
import { join } from "node:path";
import { env } from "../env.js";
import { loadProtocolSections } from "../load-config.js";
import type { KernelLike, LoginResultLike } from "../types.js";
import { ConfigError, errMsg, log } from "../util.js";
import type { KernelServices } from "./kernel-services.js";

/** Windows 反斜杠（file:// URL 化时替换）。 */
const BACKSLASH_RE = /\\/g;
/** adapter 入口 index.mjs 后缀（子路径导出替换用）。 */
const INDEX_MJS_RE = /index\.mjs$/;

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

/** network 包最小面（@napuketto/network，动态 import）。 */
interface NetworkModuleLike {
    EventBroadcaster: new () => unknown;
}

/** adapter 包 onebot11 子路径最小面（@napuketto/adapter，动态 import）。 */
interface Onebot11ModuleLike {
    ob11ConfigSchema: { parse(input: unknown): unknown };
    NapukettoOneBot11Adapter: new (
        options: Record<string, unknown>,
    ) => {
        start(): Promise<unknown>;
        stop(): Promise<void>;
    };
}

/** adapter 包 milky 子路径最小面（@napuketto/adapter，动态 import）。 */
interface MilkyModuleLike {
    milkyConfigSchema: { parse(input: unknown): unknown };
    NapukettoMilkyAdapter: new (
        options: Record<string, unknown>,
    ) => {
        start(): Promise<unknown>;
        stop(): Promise<void>;
    };
}

/** adapter 包 satori 子路径最小面（@napuketto/adapter，动态 import）。 */
interface SatoriModuleLike {
    satoriConfigSchema: { parse(input: unknown): unknown };
    NapukettoSatoriAdapter: new (
        options: Record<string, unknown>,
    ) => {
        start(): Promise<unknown>;
        stop(): Promise<void>;
    };
}

/** adapter 包 kurobot 子路径最小面（@napuketto/adapter，动态 import）。 */
interface KurobotModuleLike {
    kurobotConfigSchema: { parse(input: unknown): unknown };
    kurobotConfigDefaults: () => unknown;
    NapukettoKurobotAdapter: new (
        options: Record<string, unknown>,
    ) => {
        start(): Promise<unknown>;
        stop(): Promise<void>;
    };
}

/** adapter 包 core 子路径最小面（ProtocolConfig 框架）。 */
interface AdapterCoreModuleLike {
    ProtocolConfig: new (options: Record<string, unknown>) => unknown;
}

/**
 * 装配 OB11 + Satori 适配器（登录成功后，非 IPC 模式）。
 *
 * 返回停止函数（ob11/satori 适配器 stop：传输关闭 + 订阅清理；装配跳过时
 * no-op）——startProtocols 存入 services.stopAdapters，供未来非 IPC 软重登
 * 清理（当前软重登仅 IPC 模式有触发通道，见 relogin.ts）。
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
        const milkyAdapters: Array<{ stop(): Promise<void> }> = [];
        const network = (await import(
            `file://${networkEntry.replace(BACKSLASH_RE, "/")}`
        )) as unknown as NetworkModuleLike;
        // adapter 子路径导出（ADR-014）：onebot11 面（ob11ConfigSchema/
        // NapukettoOneBot11Adapter）走 ./onebot11，core 框架（ProtocolConfig）走 ./core。
        const onebot11Entry = adapterEntry.replace(INDEX_MJS_RE, "onebot11/index.mjs");
        const satoriEntry = adapterEntry.replace(INDEX_MJS_RE, "satori/index.mjs");
        const kurobotEntry = adapterEntry.replace(INDEX_MJS_RE, "kurobot/index.mjs");
        const milkyEntry = adapterEntry.replace(INDEX_MJS_RE, "milky/index.mjs");
        const coreEntry = adapterEntry.replace(INDEX_MJS_RE, "core/index.mjs");
        const adapter = (await import(
            `file://${onebot11Entry.replace(BACKSLASH_RE, "/")}`
        )) as unknown as Onebot11ModuleLike;
        const satoriAdapter = (await import(
            `file://${satoriEntry.replace(BACKSLASH_RE, "/")}`
        )) as unknown as SatoriModuleLike;
        const kurobotAdapter = (await import(
            `file://${kurobotEntry.replace(BACKSLASH_RE, "/")}`
        )) as unknown as KurobotModuleLike;
        const milkyAdapter = (await import(
            `file://${milkyEntry.replace(BACKSLASH_RE, "/")}`
        )) as unknown as MilkyModuleLike;
        const adapterCore = (await import(
            `file://${coreEntry.replace(BACKSLASH_RE, "/")}`
        )) as unknown as AdapterCoreModuleLike;

        const { channel, groupCache } = services;
        const broadcaster = new network.EventBroadcaster();
        // 全局 TOML 配置段：按登录账号 uin 从 accounts 取 [onebot11] / [satori] 段作 seed
        // （2026-08-08 结构拍板：协议配置嵌在账号内；未配置协议的账号不装配对应协议）。
        const { cfgFile, ob11Section, satoriSection, kurobotSection, milkySection } =
            loadProtocolSections(kernel, loginResult.uin);
        const ob11Config = new adapterCore.ProtocolConfig({
            path: cfgFile,
            schema: adapter.ob11ConfigSchema,
            defaults: adapter.ob11ConfigSchema.parse({}),
            seed: parseSeed("onebot11", adapter.ob11ConfigSchema, ob11Section),
        });
        // QQ NT global 目录（get_image/get_record 的 NT 相对路径解析基准，T5）：
        // resolveQqUserDataRoot 从 wrapper util 读 QQ 用户数据根（Documents/Tencent Files）
        const wrapperExports = (
            services.ctx as unknown as { wrapper?: { exports?: unknown } | null }
        ).wrapper?.exports;
        const qqRoot = kernel.resolveQqUserDataRoot?.(wrapperExports) ?? null;
        const mediaBaseDir = qqRoot !== null ? kernel.resolveQqGlobalPath?.(qqRoot) : undefined;
        const ob11 = new adapter.NapukettoOneBot11Adapter({
            config: ob11Config,
            broadcaster,
            msgChannel: channel,
            // OB11 request 事件源（2026-09-08）：群通知 + 好友申请推送
            groupChannel: services.groupChannel,
            friendChannel: services.friendChannel,
            // OB11 friend_add 源（B2，2026-09-08）：好友缓存快照 diff 通道
            buddyCacheEvents: (services.buddyCache as { events: unknown } | undefined)?.events,
            // 校准日志（loader logger 的 ob11 子 logger：module=ob11，级别随
            // [log.levels].ob11；2026-10-25 校准数据已降 debug + raw 截断）
            logger: services.calibLogger as
                | {
                      warn(obj: unknown, msg?: string): void;
                      info(obj: unknown, msg?: string): void;
                      debug(obj: unknown, msg?: string): void;
                  }
                | undefined,
            msgApi: services.msgApi,
            groupApi: services.groupApi,
            groupNotifyApi: services.groupNotifyApi,
            friendApi: services.friendApi,
            ticketApi: services.ticketApi,
            richMediaApi: services.richMediaApi,
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

        // Satori 协议（可选）：读 [satori] 段，装配 NapukettoSatoriAdapter。
        // 与 OB11 共用 kernel apis / 消息通道 / 广播器（多协议共存，各协议独立传输）。
        const satoriCacheDir =
            typeof satoriSection["cacheDir"] === "string" && satoriSection["cacheDir"] !== ""
                ? satoriSection["cacheDir"]
                : join(env.NAPUTO_CFG_DIR || ".", "cache");
        const satoriConfig = new adapterCore.ProtocolConfig({
            path: cfgFile,
            schema: satoriAdapter.satoriConfigSchema,
            defaults: satoriAdapter.satoriConfigSchema.parse({}),
            seed: parseSeed("satori", satoriAdapter.satoriConfigSchema, satoriSection),
        });
        const satori = new satoriAdapter.NapukettoSatoriAdapter({
            config: satoriConfig,
            broadcaster,
            msgChannel: channel,
            msgApi: services.msgApi,
            groupApi: services.groupApi,
            groupNotifyApi: services.groupNotifyApi,
            friendApi: services.friendApi,
            profileApi: services.profileApi,
            self: services.self,
            cacheDir: satoriCacheDir,
            groupCache,
        });
        await satori.start();
        log("bootstrap: satori adapter started");

        // Kurobot 协议（可选，2026-09-13）：**仅当账号段非空才装配**（url 必填，
        // 空段 parse 会炸；「段存在即启用、不写不启用」）。作为 WS 客户端连入
        // KuroBot 服务端（kurobot-ws），段内协议配置经 zod 校验作 seed。
        let kurobot: {
            start(): Promise<unknown>;
            stop(): Promise<void>;
        } | null = null;
        if (Object.keys(kurobotSection).length > 0) {
            const kurobotConfig = new adapterCore.ProtocolConfig({
                path: cfgFile,
                schema: kurobotAdapter.kurobotConfigSchema,
                defaults: kurobotAdapter.kurobotConfigDefaults(),
                seed: parseSeed("kurobot", kurobotAdapter.kurobotConfigSchema, kurobotSection),
            });
            kurobot = new kurobotAdapter.NapukettoKurobotAdapter({
                config: kurobotConfig,
                msgChannel: channel,
                msgApi: services.msgApi,
                self: services.self,
                // 接收行绑定过滤（P1-7）：握手/绑定表更新时填充，未绑定频道的
                // 接收行按 [log].unboundReceive 决定是否打印
                receiveFilter: services.receiveFilter,
                // 连接生命周期 / 握手被拒等日志（pino 实例，最小面）
                logger: services.logger as
                    | {
                          debug(obj: unknown, msg: string): void;
                          info(obj: unknown, msg: string): void;
                          warn(obj: unknown, msg: string): void;
                          error(obj: unknown, msg: string): void;
                      }
                    | undefined,
            }) as { start(): Promise<unknown>; stop(): Promise<void> };
            await kurobot.start();
            log("bootstrap: kurobot adapter started");
        }

        // Milky 协议（P0，2026-10-28）：段 enabled=true 才生效（enabled 缺省 false
        // = 空转不占端口）。单端口 HTTP（/api + /event SSE/WS）+ WebHook。
        if (Object.keys(milkySection).length > 0) {
            const milkyConfig = new adapterCore.ProtocolConfig({
                path: cfgFile,
                schema: milkyAdapter.milkyConfigSchema,
                defaults: milkyAdapter.milkyConfigSchema.parse({}),
                seed: parseSeed("milky", milkyAdapter.milkyConfigSchema, milkySection),
            });
            const milky = new milkyAdapter.NapukettoMilkyAdapter({
                config: milkyConfig,
                broadcaster,
                msgChannel: channel,
                // P1 事件通道：群请求/邀请（Group/onGroupNotifiesUpdated）+ 好友申请
                groupChannel: services.groupChannel,
                buddyChannel: services.friendChannel,
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
                recentContactApi: services.recentContactApi,
                self: services.self,
                groupCache,
                qqVersion: env.NAPUTO_QQ_VERSION || "unknown",
                // 发送远程媒体 URI 的下载缓存目录（与 OB11 download_file 同目录）
                mediaDir: join(env.NAPUTO_CFG_DIR || ".", "cache"),
                logger: services.calibLogger as
                    | {
                          warn(obj: unknown, msg?: string): void;
                          info(obj: unknown, msg?: string): void;
                      }
                    | undefined,
            }) as { start(): Promise<unknown>; stop(): Promise<void> };
            await milky.start();
            log("bootstrap: milky adapter started");
            milkyAdapters.push(milky);
        }
        return async () => {
            // 适配器 stop 幂等（started 标志守卫）：传输关闭 + kernel 事件退订
            await ob11.stop();
            await satori.stop();
            if (kurobot !== null) {
                await kurobot.stop();
            }
            for (const milky of milkyAdapters) {
                await milky.stop();
            }
        };
    } catch (e) {
        // 抛给 startProtocols 判引导失败（见函数头注释；不再吞错 fail-soft）
        log(`bootstrap: 协议装配失败: ${errMsg(e)}`);
        throw e;
    }
}
