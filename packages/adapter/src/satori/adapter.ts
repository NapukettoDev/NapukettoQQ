/**
 * NapukettoSatoriAdapter：Satori 协议适配器（P5，2026-08-08）
 *
 * - 收链路：订阅 kernel 消息事件通道 → 翻译 Satori 事件（message-created /
 *   message-deleted / guild-member-added / guild-member-removed）→ WS EVENT 信令广播
 * - 发链路：HTTP RPC（/v1/{resource}.{method}）→ 动作注册表 → kernel apis
 *
 * 生命周期走 BaseProtocolAdapter 骨架（start 校验配置 → onStart 装配传输 →
 * onStop 清理）。事件 sn 从 1 递增；非登录事件 login 只带最小字段（规范）。
 */
import type { MsgEventChannel, RawMessage } from "@napuketto/kernel";
import type { EventBroadcaster } from "@napuketto/network";
import { BaseProtocolAdapter, type ProtocolConfig } from "../core/index.js";
import { forEachRawMessage } from "../core/shared/raw-message.js";
import { createSatoriActionRegistry } from "./action/index.js";
import type { SatoriApiOptions } from "./api/index.js";
import { SatoriApi } from "./api/index.js";
import {
    collectSatoriGrayTipUids,
    hasSatoriGrayTip,
    type SatoriEventContent,
    toSatoriGrayTipEvent,
    toSatoriMessageEvent,
} from "./event/index.js";
import type { SatoriConfig } from "./helper/index.js";
import { toLogin, toMinimalLogin } from "./helper/index.js";
import type { SatoriTransportSet } from "./transport.js";
import { assembleSatoriTransports, toEventSignal } from "./transport.js";
import type { Event, Login } from "./types/index.js";

/** 适配器构造参数。 */
export interface SatoriAdapterOptions extends SatoriApiOptions {
    /** 协议配置（zod 校验 + seed 装配）。 */
    config: ProtocolConfig<SatoriConfig>;
    /** network 事件广播（注册传输后 emit 推给第三方）。 */
    broadcaster: EventBroadcaster;
    /** kernel 消息事件通道（消息收链路入口）。 */
    msgChannel: MsgEventChannel;
}

/** Satori 协议适配器。 */
export class NapukettoSatoriAdapter extends BaseProtocolAdapter<SatoriConfig> {
    readonly protocol = "satori";

    private readonly msgChannel: MsgEventChannel;
    private readonly api: SatoriApi;
    private readonly registry: ReturnType<typeof createSatoriActionRegistry>;
    private transports: SatoriTransportSet | null = null;
    private unsubscribe: (() => void) | null = null;
    private eventSn = 0;

    constructor(opts: SatoriAdapterOptions) {
        super({
            config: opts.config,
            broadcaster: opts.broadcaster,
            hooks: {
                onStart: (config) => this.startTransports(config as SatoriConfig),
                onStop: () => this.stopAll(),
                onReload: (config) => this.reloadTransports(config as SatoriConfig),
            },
        });
        this.msgChannel = opts.msgChannel;
        this.api = new SatoriApi(opts);
        // 动作注册表（HTTP RPC 分发）
        this.registry = createSatoriActionRegistry({ api: this.api });
    }

    /** 启动传输：装配（HTTP RPC + WS 事件服务）+ 打开 server + 订阅消息事件。 */
    private async startTransports(config: SatoriConfig): Promise<void> {
        const broadcaster = this.getBroadcaster();
        if (broadcaster !== undefined) {
            // 装配传输（onPathRequest / onRequest 分发已挂 registry）
            this.transports = assembleSatoriTransports({
                config,
                broadcaster,
                registry: this.registry,
                login: () => this.currentLogin(),
            });
            await Promise.all(this.transports.adapters.map((t) => t.open()));
        }
        this.subscribe();
        // 广播 login-updated（启动 → 在线）
        this.broadcastLoginUpdated(true);
    }

    /** 当前登录信息（READY logins / meta / login.get 用）。 */
    private currentLogin(): Login {
        return toLogin(this.api.self, 0, true);
    }

    /**
     * 配置热更新（2026-09-08 实现）：stop 旧传输/退订（广播 login-updated 离线）→
     * 按新配置重建（广播在线）。Satori 无 IPC 桥模式，无传输时同样走重建路径。
     */
    private async reloadTransports(config: SatoriConfig): Promise<void> {
        await this.stopAll();
        await this.startTransports(config);
    }

    /** 广播 login-updated 事件（适配器启停时）。 */
    private broadcastLoginUpdated(online: boolean): void {
        const login = toLogin(this.api.self, 0, online);
        this.broadcastEvent(
            toEventSignal({
                sn: this.nextSn(),
                type: "login-updated",
                timestamp: Date.now(),
                login,
            }),
        );
    }

    /** 停止：退订 + 关闭传输 + 广播 login-updated（离线）。 */
    private async stopAll(): Promise<void> {
        this.unsubscribeAll();
        if (this.transports !== null) {
            await this.transports.close();
            this.transports = null;
        }
        this.broadcastLoginUpdated(false);
    }

    /** 订阅 kernel 消息事件（幂等）。 */
    private subscribe(): void {
        if (this.unsubscribe !== null) {
            return;
        }
        this.unsubscribe = this.msgChannel.on("Msg/onRecvMsg", (msgs) => {
            forEachRawMessage(msgs, (msg) => {
                // grayTip（系统事件）→ 撤回/群成员变动事件；否则 → 消息事件
                if (hasSatoriGrayTip(msg)) {
                    this.broadcastGrayTip(msg).catch(() => {
                        // grayTip 翻译失败静默（结构探测期宽容）
                    });
                    return;
                }
                void this.broadcastMessageCreated(msg);
            });
        });
    }

    /** 广播消息事件（message-created）。 */
    private async broadcastMessageCreated(msg: RawMessage): Promise<void> {
        const content = await toSatoriMessageEvent(msg, {
            selfUin: this.api.selfUin,
            uidToUin: (uids) => this.api.uidToUin(uids),
        });
        // 回填频道类型缓存（收方向已知 chatType）
        this.api.setChannelType(String(msg.peerUin ?? ""), msg.chatType === 2);
        this.broadcastContent(content);
    }

    /** 广播 grayTip 事件（message-deleted / guild-member-added / removed）。 */
    private async broadcastGrayTip(msg: RawMessage): Promise<void> {
        const uids = collectSatoriGrayTipUids(msg);
        let uidToUin = new Map<string, string>();
        if (uids.length > 0) {
            uidToUin = await this.api.uidToUin(uids);
        }
        const content = await toSatoriGrayTipEvent(msg, uidToUin);
        if (content !== null) {
            this.broadcastContent(content);
        }
    }

    /** 广播事件内容（sn 递增 + 最小 login 包装 + EVENT 信令）。 */
    private broadcastContent(content: SatoriEventContent): void {
        this.broadcastEvent(
            toEventSignal({
                sn: this.nextSn(),
                type: content.type,
                timestamp: content.timestamp,
                login: toMinimalLogin(this.eventSn, this.api.selfUin),
                ...pickEventResources(content),
            }),
        );
    }

    /** 事件 sn（递增，从 1 起）。 */
    private nextSn(): number {
        this.eventSn += 1;
        return this.eventSn;
    }

    /** 退订（幂等）。 */
    private unsubscribeAll(): void {
        this.unsubscribe?.();
        this.unsubscribe = null;
    }
}

/** 从事件内容提取可选资源字段（channel/guild/message/user/member/operator）。 */
function pickEventResources(
    content: SatoriEventContent,
): Pick<Event, "channel" | "guild" | "message" | "user" | "member" | "operator"> {
    const out: Pick<Event, "channel" | "guild" | "message" | "user" | "member" | "operator"> = {};
    if (content.channel !== undefined) {
        out.channel = content.channel;
    }
    if (content.guild !== undefined) {
        out.guild = content.guild;
    }
    if (content.message !== undefined) {
        out.message = content.message;
    }
    if (content.user !== undefined) {
        out.user = content.user;
    }
    if (content.member !== undefined) {
        out.member = content.member;
    }
    if (content.operator !== undefined) {
        out.operator = content.operator;
    }
    return out;
}
