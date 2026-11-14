/**
 * kurobot 订阅接线板：管理 unsubscribes 与 kernel 频道 → 领域处理器路由。
 * kernel 只有 Msg/onRecvMsg 一个入口（QQ 群消息 → 出站帧，inbound/message）；
 * kurobridge-ws 服务端帧由 adapter 直连 inbound/server-frames（连接生命周期
 * 归 adapter 协调）。共享状态在 session.ts。
 */
import type { MsgEventChannel } from "@napuketto/kernel";
import { forEachRawMessage } from "../core/shared/raw-message.js";
import type { KurobotMessageHandler } from "./inbound/message.js";

/** 订阅接线板装配参数（频道与消息域处理器由 adapter 注入）。 */
export interface KurobotEventPipelineDeps {
    msgChannel: MsgEventChannel;
    message: KurobotMessageHandler;
}

/** kurobot 事件管道（订阅接线板）。 */
export class KurobotEventPipeline {
    private readonly message: KurobotMessageHandler;
    private readonly msgChannel: MsgEventChannel;
    private unsubscribe: (() => void) | null = null;

    constructor(deps: KurobotEventPipelineDeps) {
        this.message = deps.message;
        this.msgChannel = deps.msgChannel;
    }

    /** 订阅 kernel 消息事件（幂等）。 */
    subscribe(): void {
        if (this.unsubscribe !== null) {
            return;
        }
        this.unsubscribe = this.msgChannel.on("Msg/onRecvMsg", (msgs) => {
            forEachRawMessage(msgs, (msg) => {
                this.message.handle(msg);
            });
        });
    }

    /** 退订（幂等）。 */
    unsubscribeAll(): void {
        this.unsubscribe?.();
        this.unsubscribe = null;
    }
}
