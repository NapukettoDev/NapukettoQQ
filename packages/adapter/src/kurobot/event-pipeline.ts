/**
 * kurobot 订阅接线板：管理 unsubscribes 与 kernel 频道 → 领域处理器路由。
 * kernel 只有 Msg/onRecvMsg 一个入口（QQ 群消息 → 出站帧，inbound/message）；
 * kurobridge-ws 服务端帧由 adapter 直连 inbound/server-frames（连接生命周期
 * 归 adapter 协调）。共享状态在 session.ts。
 *
 * 消息订阅与 OB11 / Milky / Satori 共用 `subscribeRawMessages`：启动前历史群消息
 * 不触发向服务端的回帧（issue #122）。
 */
import type { MsgEventChannel } from "@napuketto/kernel";
import { subscribeRawMessages } from "../internal/domain/raw-message.js";
import type { AdapterLoggerLike } from "../internal/infra/log.js";
import type { KurobotMessageHandler } from "./inbound/message.js";

/** 订阅接线板装配参数（频道与消息域处理器由 adapter 注入）。 */
export interface KurobotEventPipelineDeps {
    msgChannel: MsgEventChannel;
    message: KurobotMessageHandler;
    /** 校准日志（可选：历史消息拦截条数留痕；缺省静默）。 */
    logger?: AdapterLoggerLike | undefined;
}

/** kurobot 事件管道（订阅接线板）。 */
export class KurobotEventPipeline {
    private readonly message: KurobotMessageHandler;
    private readonly msgChannel: MsgEventChannel;
    private readonly logger: AdapterLoggerLike | undefined;
    private unsubscribe: (() => void) | null = null;

    constructor(deps: KurobotEventPipelineDeps) {
        this.message = deps.message;
        this.msgChannel = deps.msgChannel;
        this.logger = deps.logger;
    }

    /** 订阅 kernel 消息事件（幂等）。 */
    subscribe(): void {
        if (this.unsubscribe !== null) {
            return;
        }
        this.unsubscribe = subscribeRawMessages(
            this.msgChannel,
            (msg) => {
                this.message.handle(msg);
            },
            { logger: this.logger },
        );
    }

    /** 退订（幂等）。 */
    unsubscribeAll(): void {
        this.unsubscribe?.();
        this.unsubscribe = null;
    }
}
