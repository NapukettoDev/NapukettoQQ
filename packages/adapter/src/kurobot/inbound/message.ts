/**
 * kurobot inbound 消息域（自 event-pipeline.ts 拆出）
 *
 * kernel QQ 群消息 → kurobridge-ws 出站帧：仅群聊 + 自消息过滤 + 富文本降级 +
 * 命令前缀分流（command 帧）+ 出站绑定过滤（chat 帧）。连接出口经 conn 面
 * （未 established 时连接层直接丢弃）。富文本降级与模板渲染在 translate.ts。
 */
import { randomUUID } from "node:crypto";
import type { RawMessage } from "@napuketto/kernel";
import { ChatType } from "@napuketto/kernel";
import type { KurobotConnFace } from "../adapter.js";
import type { KurobotConfig } from "../config.js";
import type { KurobotConnectionOptions } from "../connection.js";
import type { KurobotSession } from "../session.js";
import { degradeMessage, resolveSenderName } from "../translate.js";

/** 消息域处理装配参数（adapter 注入）。 */
export interface KurobotMessageHandlerDeps {
    /** 当前登录账号 uin（自消息过滤）。 */
    selfUin: string;
    /** 当前生效配置（收链路取 commandPrefix 等；未启动时 null）。 */
    currentConfig: () => KurobotConfig | null;
    conn: KurobotConnFace;
    session: KurobotSession;
    logger?: KurobotConnectionOptions["logger"] | undefined;
}

/** kurobot 消息域处理器（kernel 群消息 → 出站帧）。 */
export class KurobotMessageHandler {
    private readonly selfUin: string;
    private readonly currentConfig: () => KurobotConfig | null;
    private readonly conn: KurobotConnFace;
    private readonly session: KurobotSession;
    private readonly log: KurobotConnectionOptions["logger"];

    constructor(deps: KurobotMessageHandlerDeps) {
        this.selfUin = deps.selfUin;
        this.currentConfig = deps.currentConfig;
        this.conn = deps.conn;
        this.session = deps.session;
        this.log = deps.logger;
    }

    /** kernel 群消息 → kurobot 出站（仅群聊 + 自消息过滤 + 命令分流 + 绑定过滤）。 */
    handle(msg: RawMessage): void {
        const config = this.currentConfig();
        if (config === null) {
            return; // 未启动静默忽略（原 handleIncomingMessage 语义）
        }
        if (msg.chatType !== ChatType.GROUP) {
            return;
        }
        // 过滤自己发的消息防回环（本账号其它端发送同样过滤）
        if (String(msg.senderUin) === this.selfUin) {
            return;
        }
        const channel = msg.peerUid;
        if (channel === "") {
            return;
        }
        const text = degradeMessage(msg);
        if (text === null) {
            return;
        }
        // 命令前缀 → command 帧（管理员判定在服务端；不做绑定过滤，语义对齐服务端 dispatchCommand）
        if (text.startsWith(config.commandPrefix)) {
            const command = text.slice(config.commandPrefix.length).trim();
            if (command === "") {
                return; // 空命令（只有前缀）忽略
            }
            this.sendCommand(channel, command, String(msg.senderUin));
            return;
        }
        // 出站绑定过滤：空快照 = 全部不发（对齐服务端空绑定丢弃语义）
        if (!this.session.isBound(channel)) {
            this.log?.debug({ channel }, "kurobot: 非绑定群，跳过 chat 帧");
            return;
        }
        this.conn.send({
            type: "chat",
            body: { channel, sender: resolveSenderName(msg), content: text },
        });
    }

    /** 发 command 请求帧（登记 pending 表供 command_result 关联）。 */
    private sendCommand(channel: string, command: string, userId: string): void {
        const id = randomUUID();
        this.session.pendingCommands.set(id, channel);
        const sent = this.conn.send({
            type: "command",
            id,
            body: { command, source: { channel, userId } },
        });
        if (sent !== true) {
            this.session.pendingCommands.delete(id);
        }
    }
}
