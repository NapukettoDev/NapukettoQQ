/**
 * NapukettoOneBot11Adapter：OneBot 11 协议适配器（收发闭环）
 *
 * 收链路：订阅 kernel 消息事件通道 → RawMessage 翻译 OB11 事件 → network 广播；
 * 发链路：handleRequest（{ action, params, echo }）→ 动作注册表 → kernel apis。
 * 生命周期走 BaseProtocolAdapter 骨架。本类只做协调（构造装配 / 传输启停 /
 * 心跳 / 请求分发）：事件订阅与派发在 event-pipeline.ts，翻译前异步回填在
 * enrichment.ts。
 */
import type {
    BuddyCacheEventChannel,
    BuddyEventChannel,
    GroupEventChannel,
    MsgEventChannel,
} from "@napuketto/kernel";
import type { EventBroadcaster } from "@napuketto/network";
import { BaseProtocolAdapter, type ConfigBase } from "../core/index.js";
import type { AdapterLoggerLike } from "../shared/log.js";
import { MS_TO_SEC } from "../shared/uid-uin.js";
import type { ActionResult } from "./action/base-action.js";
import { createOb11ActionRegistry } from "./action/index.js";
import type { OneBotApiOptions } from "./api/one-bot-api.js";
import { OneBotApi } from "./api/one-bot-api.js";
import { Ob11EventPipeline } from "./event-pipeline.js";
import type { OB11Config } from "./helper/index.js";
import type { Ob11TransportSet } from "./transport.js";
import { assembleOb11Transports } from "./transport.js";

export type { AdapterLoggerLike } from "../shared/log.js";

/** 适配器构造参数（api 相关字段继承 OneBotApiOptions， 聚合）。 */
export interface OneBot11AdapterOptions extends OneBotApiOptions {
    /** 协议配置（zod 校验 + JSON 读写）。 */
    config: ConfigBase<OB11Config>;
    /** network 事件广播（注册传输适配器后 emit 推给第三方）。 */
    broadcaster: EventBroadcaster;
    /** kernel 消息事件通道（消息收链路入口）。 */
    msgChannel: MsgEventChannel;
    /** kernel 群事件通道（可选：Group/onGroupNotifiesUpdated → OB11 request 源）。 */
    groupChannel?: GroupEventChannel;
    /** kernel 好友事件通道（可选：Buddy/onBuddyReqChange → OB11 request 源）。 */
    friendChannel?: BuddyEventChannel;
    /** 好友缓存 diff 通道（可选：BuddyCache/onBuddyAdded → OB11 friend_add 源，）。 */
    buddyCacheEvents?: BuddyCacheEventChannel;
    /** 校准日志（可选：未知事件形状 raw JSON；IPC 模式传 loader pino 实例）。 */
    logger?: AdapterLoggerLike;
}

/** OneBot 11 协议适配器。 */
export class NapukettoOneBot11Adapter extends BaseProtocolAdapter<OB11Config> {
    readonly protocol = "onebot11";

    private readonly selfUin: string;
    private readonly oneBotApi: OneBotApi;
    /** 动作注册表（公共只读：IPC 桥等装配方枚举动作名直接挂载）。 */
    readonly registry: ReturnType<typeof createOb11ActionRegistry>;
    /** 收链路事件管道（订阅 / 过滤 / 翻译派发，拆出）。 */
    private readonly pipeline: Ob11EventPipeline;
    private transports: Ob11TransportSet | null = null;
    private heartbeatTimer: NodeJS.Timeout | null = null;
    /** IPC 桥模式标记（subscribeOnly 启动；reload 时跳过传输重建）。 */
    private subscribedOnly = false;

    constructor(opts: OneBot11AdapterOptions) {
        super({
            config: opts.config,
            broadcaster: opts.broadcaster,
            hooks: {
                onStart: (config) => this.startTransports(config),
                onStop: () => this.stopAll(),
                onReload: (config) => this.reloadTransports(config),
            },
        });
        this.selfUin = opts.self.uin;
        this.oneBotApi = new OneBotApi(opts);
        this.pipeline = new Ob11EventPipeline({
            selfUin: this.selfUin,
            api: this.oneBotApi,
            broadcast: (event) => this.broadcastEvent(event),
            ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
            msgChannel: opts.msgChannel,
            ...(opts.groupChannel !== undefined ? { groupChannel: opts.groupChannel } : {}),
            ...(opts.friendChannel !== undefined ? { friendChannel: opts.friendChannel } : {}),
            ...(opts.buddyCacheEvents !== undefined
                ? { buddyCacheEvents: opts.buddyCacheEvents }
                : {}),
        });
        this.registry = createOb11ActionRegistry({ api: this.oneBotApi });
    }

    /**
     * 配置热更新（实现）：stop 旧传输/心跳/退订 → 按新配置重建。
     * IPC 桥模式（subscribeOnly，无传输）只刷新上报开关字段，不重建。
     */
    private async reloadTransports(config: OB11Config): Promise<void> {
        if (this.subscribedOnly) {
            this.pipeline.applyConfig(config);
            return;
        }
        await this.stopAll();
        await this.startTransports(config);
    }

    /** 启动传输：装配（HTTP/WS）+ 打开 server/client + 广播 lifecycle enable + 起心跳。 */
    private async startTransports(config: OB11Config): Promise<void> {
        // start() 即装传输：脱离 IPC 桥模式（复查发现的潜在混用序，防御复位）
        this.subscribedOnly = false;
        // 全局上报开关与消息格式（订阅处消费）
        this.pipeline.applyConfig(config);
        const broadcaster = this.getBroadcaster();
        if (broadcaster !== undefined) {
            this.transports = assembleOb11Transports({
                config,
                broadcaster,
                selfUin: this.selfUin,
                handleRequest: (req, respond) => {
                    this.handleRequest(req, respond).catch((err: unknown) => {
                        let message = String(err);
                        if (err instanceof Error) {
                            message = err.message;
                        }
                        // 兜底响应同样透传 echo（WS 客户端按 echo 关联请求）
                        respond({
                            status: "failed",
                            retcode: 999,
                            data: null,
                            message,
                            ...echoFieldOf(req),
                        });
                    });
                },
            });
            await Promise.all(this.transports.servers.map((s) => s.open()));
            await Promise.all(this.transports.transports.map((t) => t.open()));
        }
        this.pipeline.subscribe();
        this.broadcastEvent({
            time: Math.floor(Date.now() / MS_TO_SEC),
            self_id: Number(this.selfUin),
            post_type: "meta_event",
            meta_event_type: "lifecycle",
            sub_type: "enable",
        });
        this.startHeartbeat(config.heartbeatInterval);
    }

    /** 心跳 meta 事件（interval 毫秒，0 关闭；启动前清理残留定时器防重复）。 */
    private startHeartbeat(intervalMs: number): void {
        if (intervalMs <= 0) {
            return;
        }
        if (this.heartbeatTimer !== null) {
            clearInterval(this.heartbeatTimer);
        }
        this.heartbeatTimer = setInterval(() => {
            this.broadcastEvent({
                time: Math.floor(Date.now() / MS_TO_SEC),
                self_id: Number(this.selfUin),
                post_type: "meta_event",
                meta_event_type: "heartbeat",
                interval: intervalMs,
                status: { online: true, good: true },
            });
        }, intervalMs);
    }

    /** 停止：心跳 + 传输 + 退订。 */
    private async stopAll(): Promise<void> {
        if (this.heartbeatTimer !== null) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        this.pipeline.unsubscribeAll();
        if (this.transports !== null) {
            await this.transports.close();
            this.transports = null;
        }
    }

    /**
     * 仅启动接收链路（IPC 桥模式）：订阅消息通道维护 messageUnique +
     * 灰色通知翻译；与 start() 的差别仅在传输层（无 HTTP/WS、无心跳、无 lifecycle）。
     * 配置经 seed 装配（load() 返回内存初值）。
     */
    async subscribeOnly(): Promise<void> {
        const config = await this.config.load();
        this.pipeline.applyConfig(config);
        this.subscribedOnly = true;
        this.pipeline.subscribe();
    }

    /** 仅退订（与 subscribeOnly 配对的进程级清理；传输关闭仍走 stop()）。 */
    unsubscribeOnly(): void {
        this.subscribedOnly = false;
        this.pipeline.unsubscribeAll();
    }

    /** 请求分发（挂到 transport 的 onRequest）：{ action, params, echo } → 注册表分发。 */
    async handleRequest(req: unknown, respond: (res: unknown) => void): Promise<void> {
        const parsed = (req ?? {}) as { action?: unknown; params?: unknown; echo?: unknown };
        // params 缺省 {}（OB11 规范允许省略；schema 校验在动作内，此处不判类型）
        const { action: rawAction, echo } = parsed;
        const params = parsed.params ?? {};
        let action = "";
        if (typeof rawAction === "string") {
            action = rawAction;
        }
        // 错误响应同样透传 echo（WS 客户端按 echo 关联请求/响应）
        if (action === "") {
            respond({
                status: "failed",
                retcode: 404,
                data: null,
                message: "请求缺少 action",
                ...(echo !== undefined ? { echo } : {}),
            });
            return;
        }
        const act = this.registry.get(action);
        if (act === undefined) {
            respond({
                status: "failed",
                retcode: 404,
                data: null,
                message: `未知动作: ${action}`,
                ...(echo !== undefined ? { echo } : {}),
            });
            return;
        }
        let result: ActionResult<unknown>;
        if (echo === undefined) {
            result = await act.handle(params);
        } else {
            result = await act.websocketHandle(params, echo);
        }
        respond(result);
    }
}

/** 请求体 echo 字段提取（透传用；非对象 / 缺省 / undefined 返回空对象）。 */
function echoFieldOf(req: unknown): { echo: unknown } | Record<string, never> {
    if (req !== null && typeof req === "object") {
        const echo = (req as { echo?: unknown }).echo;
        if (echo !== undefined) {
            return { echo };
        }
    }
    return {};
}
