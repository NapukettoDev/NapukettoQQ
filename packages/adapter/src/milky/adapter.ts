/**
 * NapukettoMilkyAdapter：Milky 协议适配器
 *
 * 第四个协议适配器（与 OB11/Satori/KuroBot 并行）：单端口 HTTP（/api + /event）
 * + WebHook。收链路三源（消息通道 / 群通知 / 好友申请，再加 sysmsg、
 * 私聊文件、精华 diff、置顶翻转、登录掉线），发链路 /api 动作 → kernel apis。
 *
 * 生命周期走 BaseProtocolAdapter 骨架；config.enabled=false 时空转（不订阅、
 * 不起传输）。本类只做协调（构造装配 / 传输启停）：事件订阅与派发在
 * event-pipeline.ts，翻译前异步回填在 enrichment.ts。
 */
import type {
    BuddyEventChannel,
    GroupEventChannel,
    LoginEventChannel,
    MsgEventChannel,
    RecentContactEventChannel,
} from "@napuketto/kernel";
import type { EventBroadcaster } from "@napuketto/network";
import { BaseProtocolAdapter, type ConfigBase, type ProtocolHooks } from "../core/index.js";
import { createMilkyActionRegistry } from "./action/index.js";
import { MilkyApi, type MilkyApiOptions } from "./api.js";
import type { MilkyConfig } from "./config.js";
import { MilkyEnrichment } from "./enrichment.js";
import { MilkyEventPipeline } from "./event-pipeline.js";
import { MessageSeqIndex } from "./helper/state/seq-index.js";
import { MilkyInboundEssence } from "./inbound/essence.js";
import { MilkyInboundFileNotice } from "./inbound/file-notice.js";
import { MilkyInboundMessage } from "./inbound/message.js";
import { MilkyInboundPin } from "./inbound/pin.js";
import { MilkyInboundRequest } from "./inbound/request.js";
import { MilkyInboundSysMsg } from "./inbound/sysmsg.js";
import { assembleMilkyTransports, type MilkyLoggerLike } from "./transport.js";

/** 适配器构造参数（api 相关字段继承 MilkyApiOptions）。 */
export interface MilkyAdapterOptions extends MilkyApiOptions {
    config: ConfigBase<MilkyConfig>;
    broadcaster: EventBroadcaster;
    /** kernel 消息事件通道（收链路入口）。 */
    msgChannel: MsgEventChannel;
    /** kernel 群事件通道（群请求/邀请推送；缺省不订阅）。 */
    groupChannel?: GroupEventChannel;
    /** kernel 好友事件通道（好友申请推送；缺省不订阅）。 */
    buddyChannel?: BuddyEventChannel;
    /** kernel 会话列表事件通道（peer_pin_change；缺省不订阅）。 */
    recentContactChannel?: RecentContactEventChannel;
    /** kernel 登录状态事件通道（bot_offline；缺省不订阅）。 */
    loginChannel?: LoginEventChannel;
    /** 校准日志（webhook 失败 / 启停提示 / 未知事件形状；IPC 模式传 loader pino 实例）。 */
    logger?: MilkyLoggerLike;
}

export class NapukettoMilkyAdapter extends BaseProtocolAdapter<MilkyConfig> {
    readonly protocol = "milky";

    private readonly calibLogger: MilkyLoggerLike | undefined;
    private readonly api: MilkyApi;
    /** seq 双向登记索引（发送回查 / reply 回填 / 转发定位共享）。 */
    private readonly seqIndex = new MessageSeqIndex();
    /** 动作注册表（公共只读：装配方/测试枚举）。 */
    readonly registry: ReturnType<typeof createMilkyActionRegistry>;
    /** 收链路事件管道（订阅 / 过滤 / 去重 / 翻译派发，拆出）。 */
    private readonly pipeline: MilkyEventPipeline;
    private stopTransports: (() => Promise<void>) | null = null;

    constructor(opts: MilkyAdapterOptions) {
        const hooks: ProtocolHooks<MilkyConfig> = {
            onStart: (config) => this.startTransports(config),
            onStop: () => this.stopAll(),
            onReload: (config) => this.reloadTransports(config),
        };
        super({
            config: opts.config,
            broadcaster: opts.broadcaster,
            hooks,
        });
        this.calibLogger = opts.logger;
        this.api = new MilkyApi(opts, this.seqIndex);
        // 领域处理器装配归 adapter；pipeline 接线板只做频道 → 处理器路由
        const base = {
            api: this.api,
            seqIndex: this.seqIndex,
            broadcast: (event: unknown) => this.broadcastEvent(event),
            logger: opts.logger,
        };
        const enrich = new MilkyEnrichment({ api: this.api });
        const essence = new MilkyInboundEssence(base);
        this.pipeline = new MilkyEventPipeline({
            msgChannel: opts.msgChannel,
            ...(opts.groupChannel !== undefined ? { groupChannel: opts.groupChannel } : {}),
            ...(opts.buddyChannel !== undefined ? { buddyChannel: opts.buddyChannel } : {}),
            ...(opts.recentContactChannel !== undefined
                ? { recentContactChannel: opts.recentContactChannel }
                : {}),
            ...(opts.loginChannel !== undefined ? { loginChannel: opts.loginChannel } : {}),
            essence,
            message: new MilkyInboundMessage({ ...base, enrich }),
            sysMsg: new MilkyInboundSysMsg({ ...base, essence }),
            request: new MilkyInboundRequest({ ...base, enrich }),
            fileNotice: new MilkyInboundFileNotice(base),
            pin: new MilkyInboundPin(base),
            logger: opts.logger,
        });
        this.registry = createMilkyActionRegistry({ api: this.api });
    }

    /** 启动传输 + 订阅（enabled=false 空转：不订阅不起传输）。 */
    private async startTransports(config: MilkyConfig): Promise<void> {
        if (!config.enabled) {
            this.calibLogger?.info({}, "milky: 未启用（enabled=false），跳过装配");
            return;
        }
        const broadcaster = this.getBroadcaster();
        if (broadcaster !== undefined) {
            const set = assembleMilkyTransports({
                config,
                broadcaster,
                registry: this.registry,
                ...(this.calibLogger !== undefined ? { logger: this.calibLogger } : {}),
            });
            this.stopTransports = set.close;
            // 启动监听（satori/OB11 startTransports 同款）：server.open 实绑端口，
            // hub / webhook client 的 open 均为 no-op。实机发现：缺此步
            // milky HTTP 从未监听（集成测试一直显式 open 掩盖了该缺口）。
            await Promise.all(set.adapters.map((a) => a.open()));
        }
        this.pipeline.subscribe();
        this.calibLogger?.info(
            { host: config.host, port: config.port, modes: config.eventModes },
            "milky: adapter started",
        );
    }

    /** 热更新：停止重建（enabled 切换生效）。 */
    private async reloadTransports(config: MilkyConfig): Promise<void> {
        await this.stopAll();
        await this.startTransports(config);
    }

    /** 停止：退订 + 关传输。 */
    private async stopAll(): Promise<void> {
        this.pipeline.unsubscribeAll();
        if (this.stopTransports !== null) {
            await this.stopTransports();
            this.stopTransports = null;
        }
    }
}
