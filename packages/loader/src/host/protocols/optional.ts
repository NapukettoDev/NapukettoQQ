/**
 * optional.ts：可选协议（Satori / Kurobot / Milky）装配（2026-11-25 从
 * assemble-ob11.ts 拆出）。
 *
 * 「段存在即启用、不写不启用」：账号配置段为空 = 该协议关闭，连 adapter 子路径都
 * 不 `import()`（ADR-014 按需加载，未启用协议零加载、零实例化）。
 *
 * 协议隔离（2026-11-10）：每个协议一个独立 EventBroadcaster，事件只推给本协议的
 * 传输客户端；kurobot 是纯客户端出向协议（无第三方接入门面、不发协议事件），
 * 因此没有广播器。
 *
 * 拆分边界：本文件只含「可选协议」的构造器与按配置顺序启动；OB11 主装配留在
 * assemble-ob11.ts。`startAdapter` / `stopAdapters` 是两者共用的生命周期原语，
 * 因此也从这里导出（单向依赖：assemble-ob11 → optional）。
 */
import { join } from "node:path";
import { isShuttingDown } from "../../lifecycle/shutdown.js";
import { log } from "../../shared/boot-log.js";
import { getErrorMessage } from "../../shared/type-guards.js";
import { env } from "../runtime/env.js";
import { localMediaBaseDir, parseProtocolSeed } from "../runtime/load-config.js";
import { hasSection } from "../runtime/module-loader.js";
import type {
    AdapterCoreModuleLike,
    AdapterLifecycleLike,
    KurobotModuleLike,
    MilkyModuleLike,
    NetworkModuleLike,
    SatoriModuleLike,
} from "../runtime/protocol-types.js";
import type { KernelLike } from "../runtime/types.js";
import type { KernelServices } from "./kernel-services.js";

/** 可选协议 adapter 生命周期最小面（start/stop；= protocol-types 的同一契约）。 */
export type AdapterHandle = AdapterLifecycleLike;

/** 可选协议装配的公共依赖（广播器 / 配置框架 / seed 来源 / kernel 服务）。 */
export interface OptionalAssemblyDeps {
    mediaBaseDir: string | undefined;
    kernel: KernelLike;
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
function createSatori(input: SatoriAssemblyInput): AdapterHandle | null {
    const { section, services } = input;
    if (!hasSection(section)) {
        return null;
    }
    const broadcaster = new input.network.EventBroadcaster();
    // cacheDir 缺省：落账号目录 cache（与 OB11 download_file 同目录）
    let cacheDir = join(env.NAPUKETTO_CFG_DIR || ".", "cache");
    const configuredCacheDir = section["cacheDir"];
    if (typeof configuredCacheDir === "string" && configuredCacheDir !== "") {
        cacheDir = configuredCacheDir;
    }
    cacheDir =
        input.kernel.resolveSandboxWritePath?.(cacheDir, "accounts.satori.cacheDir") ?? cacheDir;
    const config = new input.adapterCore.ProtocolConfig({
        path: input.cfgFile,
        schema: input.satoriAdapter.satoriConfigSchema,
        defaults: input.satoriAdapter.satoriConfigSchema.parse({}),
        seed: parseProtocolSeed("satori", input.satoriAdapter.satoriConfigSchema, section),
    });
    return new input.satoriAdapter.NapukettoSatoriAdapter({
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
        mediaBaseDir: input.mediaBaseDir,
        localMediaBaseDir: localMediaBaseDir(
            input.cfgFile,
            env.NAPUKETTO_DATA ?? env.NAPUKETTO_CFG_DIR,
        ),
        groupCache: services.groupCache,
    });
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
function createKurobot(input: KurobotAssemblyInput): AdapterHandle {
    const { section, services } = input;
    const config = new input.adapterCore.ProtocolConfig({
        path: input.cfgFile,
        schema: input.kurobotAdapter.kurobotConfigSchema,
        defaults: input.kurobotAdapter.kurobotConfigDefaults(),
        seed: parseProtocolSeed("kurobot", input.kurobotAdapter.kurobotConfigSchema, section),
    });
    return new input.kurobotAdapter.NapukettoKurobotAdapter({
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
function createMilky(input: MilkyAssemblyInput): AdapterHandle {
    const { section, services } = input;
    const broadcaster = new input.network.EventBroadcaster();
    const config = new input.adapterCore.ProtocolConfig({
        path: input.cfgFile,
        schema: input.milkyAdapter.milkyConfigSchema,
        defaults: input.milkyAdapter.milkyConfigSchema.parse({}),
        seed: parseProtocolSeed("milky", input.milkyAdapter.milkyConfigSchema, section),
    });
    return new input.milkyAdapter.NapukettoMilkyAdapter({
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
        qqVersion: env.NAPUKETTO_QQ_VERSION || "unknown",
        // 发送远程媒体 URI 的下载缓存目录（与 OB11 download_file 同目录）
        mediaDir: join(env.NAPUKETTO_CFG_DIR || ".", "cache"),
        localMediaBaseDir: localMediaBaseDir(
            input.cfgFile,
            env.NAPUKETTO_DATA ?? env.NAPUKETTO_CFG_DIR,
        ),
        logger: services.calibLogger,
    });
}

/** 可选协议子模块（undefined = 段为空，未加载）。 */
export interface OptionalModules {
    satori: SatoriModuleLike | undefined;
    kurobot: KurobotModuleLike | undefined;
    milky: MilkyModuleLike | undefined;
}

/** 可选协议段（键与 OptionalModules 对齐）。 */
export interface OptionalSections {
    satori: Record<string, unknown>;
    kurobot: Record<string, unknown>;
    milky: Record<string, unknown>;
}

/** 停止动作相互独立，某个传输异常或挂起时其他协议也会尝试退出。 */
export async function stopAdapters(adapters: AdapterHandle[]): Promise<void> {
    await Promise.all(
        adapters
            .splice(0)
            .reverse()
            .map(async (adapter) => {
                try {
                    await adapter.stop();
                } catch (err) {
                    log(`bootstrap: 协议关停失败: ${getErrorMessage(err)}`);
                }
            }),
    );
}

/** 启动单个 adapter（关停窗口内不启动；启动期间进入关停则立刻回收）。 */
export async function startAdapter(
    adapters: AdapterHandle[],
    adapter: AdapterHandle | null,
    name: string,
): Promise<void> {
    if (adapter === null || isShuttingDown()) {
        return;
    }
    adapters.push(adapter);
    await adapter.start();
    log(`bootstrap: ${name} adapter started`);
    if (isShuttingDown()) {
        await stopAdapters([adapter]);
    }
}

/** 按配置顺序启动可选协议，启动失败时共享列表仍保留已构造的实例。 */
export async function assembleOptionalProtocols(
    deps: OptionalAssemblyDeps,
    sections: OptionalSections,
    modules: OptionalModules,
    adapters: AdapterHandle[],
): Promise<void> {
    if (modules.satori !== undefined && !isShuttingDown()) {
        await startAdapter(
            adapters,
            createSatori({
                ...deps,
                satoriAdapter: modules.satori,
                section: sections.satori,
            }),
            "satori",
        );
    }
    if (modules.kurobot !== undefined && !isShuttingDown()) {
        await startAdapter(
            adapters,
            createKurobot({
                ...deps,
                kurobotAdapter: modules.kurobot,
                section: sections.kurobot,
            }),
            "kurobot",
        );
    }
    if (modules.milky !== undefined && !isShuttingDown()) {
        await startAdapter(
            adapters,
            createMilky({
                ...deps,
                milkyAdapter: modules.milky,
                section: sections.milky,
            }),
            "milky",
        );
    }
}
