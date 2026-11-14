/**
 * kurobot 事件管道（2026-11-14 自 adapter.ts 拆分）
 *
 * 双向事件流：QQ 群消息 → 绑定过滤 / 命令分流 → kurobridge-ws 帧（出向）；
 * 服务端帧 → 模板渲染 → kernel 群文本发送（入向）。持有绑定集、pending
 * 命令/查询表与 status 快照；连接生命周期由 adapter 协调，经 conn 出口面发帧。
 */
import { randomUUID } from "node:crypto";
import type { MsgEventChannel, RawMessage } from "@napuketto/kernel";
import { ChatType } from "@napuketto/kernel";
import { forEachRawMessage } from "../core/shared/raw-message.js";
import type { KurobotMsgApi, ReceiveLogFilterHolder } from "./adapter.js";
import type { KurobotConfig } from "./config.js";
import type {
    ConnectionEndedReason,
    KurobotConnectionOptions,
    ServerEventMessage,
} from "./connection.js";
import type { HelloAckOkBody, StatusBody } from "./schema.js";
import {
    degradeMessage,
    renderCommandResult,
    renderDeathText,
    renderTemplate,
    resolveSenderName,
    truncateForGroup,
} from "./translate.js";

/** 连接出口面（adapter 持有连接生命周期；未建立连接时 send 恒 false / established 恒 false）。 */
export interface KurobotConnFace {
    /** 发帧（未 established 时连接层直接丢弃并返回 false）。 */
    send: (frame: { type: string; body: unknown; id?: string }) => boolean;
    /** 连接是否已建立（hello_ack ok）。 */
    isEstablished: () => boolean;
}

/** 事件管道装配参数（频道 / api / 出口面由 adapter 注入）。 */
export interface KurobotEventPipelineDeps {
    msgChannel: MsgEventChannel;
    msgApi: KurobotMsgApi;
    /** 当前登录账号 uin（自消息过滤）。 */
    selfUin: string;
    /** 日志面（缺省静默）。 */
    logger?: KurobotConnectionOptions["logger"] | undefined;
    /** 接收行绑定过滤 holder（绑定集变更后同步；停止/终止时清空）。 */
    receiveFilter?: ReceiveLogFilterHolder | undefined;
    /** 当前生效配置（收链路取 commandPrefix 等；未启动时 null）。 */
    currentConfig: () => KurobotConfig | null;
    /** 当前生效配置（启动后调用；未启动抛错，原 adapter requireConfig 语义）。 */
    requireConfig: () => KurobotConfig;
    conn: KurobotConnFace;
}

/** kurobot 事件管道（QQ↔kurobridge-ws 双向分发 + 绑定/pending 状态）。 */
export class KurobotEventPipeline {
    private readonly msgChannel: MsgEventChannel;
    private readonly msgApi: KurobotMsgApi;
    private readonly selfUin: string;
    private readonly log: KurobotConnectionOptions["logger"];
    private readonly receiveFilter: ReceiveLogFilterHolder | undefined;
    private readonly currentConfig: () => KurobotConfig | null;
    private readonly requireConfig: () => KurobotConfig;
    private readonly conn: KurobotConnFace;
    private unsubscribe: (() => void) | null = null;
    /** 出站绑定集（hello_ack 快照 + bindings_updated 全量替换；空集 = 全部不发）。 */
    private bindings = new Set<string>();
    /** command 请求 UUID → 回发群号（command_result 帧无 channel，靠 id 关联）。 */
    private pendingCommands = new Map<string, string>();
    /** query 请求 UUID → 查询类别。 */
    private pendingQueries = new Map<string, "status" | "bindings">();
    /** 最近一帧 status 快照（仅缓存不发群，M-04 决策同构）。 */
    private lastStatus: StatusBody | null = null;

    constructor(deps: KurobotEventPipelineDeps) {
        this.msgChannel = deps.msgChannel;
        this.msgApi = deps.msgApi;
        this.selfUin = deps.selfUin;
        this.log = deps.logger;
        this.receiveFilter = deps.receiveFilter;
        this.currentConfig = deps.currentConfig;
        this.requireConfig = deps.requireConfig;
        this.conn = deps.conn;
    }

    /** 最近一帧 status 快照（仅缓存；无帧时 null）。 */
    getLastStatus(): StatusBody | null {
        return this.lastStatus;
    }

    /** 发起 query 请求（status/bindings）。MVP 未接 QQ 触发面——预留能力（见 design.md §8）。 */
    query(kind: "status" | "bindings"): boolean {
        if (!this.conn.isEstablished()) {
            return false;
        }
        const id = randomUUID();
        this.pendingQueries.set(id, kind);
        return this.conn.send({ type: "query", id, body: { kind } });
    }

    /** 启动期重置：清绑定集与 pending 表、status 快照（对齐原 startKurobot 序）。 */
    resetForStart(): void {
        this.bindings = new Set();
        this.pendingCommands.clear();
        this.pendingQueries.clear();
        this.lastStatus = null;
    }

    /** 停止清理：退订 + 清 pending 表 + 清接收过滤（绑定集留给下次握手覆盖）。 */
    stop(): void {
        this.unsubscribeAll();
        this.pendingCommands.clear();
        this.pendingQueries.clear();
        if (this.receiveFilter !== undefined) {
            this.receiveFilter.current = null;
        }
    }

    /** 握手成功：绑定集整体替换为服务端快照 + 清上一连接的 pending 表。 */
    onEstablished(ack: HelloAckOkBody): void {
        this.pendingCommands.clear();
        this.pendingQueries.clear();
        this.bindings = new Set(ack.channelBindings);
        this.syncReceiveFilter();
    }

    /** 连接永久停止（1002/1008/hello_ack 拒绝）：清 pending 与接收过滤。 */
    onEnded(reason: ConnectionEndedReason): void {
        this.pendingCommands.clear();
        this.pendingQueries.clear();
        if (this.receiveFilter !== undefined) {
            this.receiveFilter.current = null;
        }
        this.log?.error({ reason }, "kurobot: 连接终止");
    }

    /** 服务端帧分发（渲染回群 / 缓存 / 绑定集维护 / 命令结果关联回发）。 */
    onServerFrame(msg: ServerEventMessage): void {
        switch (msg.type) {
            case "pong":
                // 心跳响应不需要处理（任务书 §1.2：收不到就等服务端 1001 关闭走重连）
                return;
            case "chat":
                this.sendToGroup(
                    msg.body.channel,
                    renderTemplate(this.requireConfig().chatTemplate, {
                        player: msg.body.playerName,
                        content: msg.body.content,
                    }),
                );
                return;
            case "join":
                this.sendToGroup(
                    msg.body.channel,
                    renderTemplate(this.requireConfig().joinTemplate, {
                        player: msg.body.playerName,
                    }),
                );
                return;
            case "leave":
                this.sendToGroup(
                    msg.body.channel,
                    renderTemplate(this.requireConfig().leaveTemplate, {
                        player: msg.body.playerName,
                    }),
                );
                return;
            case "death":
                this.sendToGroup(
                    msg.body.channel,
                    truncateForGroup(
                        renderDeathText(
                            this.requireConfig().deathTemplate,
                            msg.body.player,
                            msg.body.message,
                        ),
                    ),
                );
                return;
            case "status":
                // 仅缓存不发群（防刷屏）
                this.lastStatus = msg.body;
                this.log?.debug({ status: msg.body }, "kurobot: status 已缓存");
                return;
            case "bindings_updated":
                this.bindings = new Set(msg.body.channelBindings);
                this.syncReceiveFilter();
                this.log?.info({ bindings: msg.body.channelBindings }, "kurobot: 绑定表已更新");
                return;
            case "command_result": {
                const channel = this.pendingCommands.get(msg.id);
                if (channel === undefined) {
                    this.log?.warn({ id: msg.id }, "kurobot: command_result 无对应请求，丢弃");
                    return;
                }
                this.pendingCommands.delete(msg.id);
                this.sendToGroup(channel, truncateForGroup(renderCommandResult(msg.body)));
                return;
            }
            case "query_result": {
                this.onQueryResult(msg.id, msg.body);
                return;
            }
        }
    }

    /** kernel 群消息 → kurobot 出站（仅群聊 + 自消息过滤 + 命令分流 + 绑定过滤）。 */
    handleIncomingMessage(msg: RawMessage): void {
        const config = this.currentConfig();
        if (config === null) {
            return;
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
        if (this.bindings.size === 0 || !this.bindings.has(channel)) {
            this.log?.debug({ channel }, "kurobot: 非绑定群，跳过 chat 帧");
            return;
        }
        this.sendChat(channel, resolveSenderName(msg), text);
    }

    /** query_result 处理：bindings 刷新绑定集（防御性收窄）；status 缓存。 */
    private onQueryResult(
        id: string,
        body: { ok: true; data?: unknown } | { ok: false; error: string },
    ): void {
        const kind = this.pendingQueries.get(id);
        if (kind === undefined) {
            this.log?.warn({ id }, "kurobot: query_result 无对应请求，丢弃");
            return;
        }
        this.pendingQueries.delete(id);
        if (!body.ok) {
            this.log?.warn({ kind, error: body.error }, "kurobot: 查询失败");
            return;
        }
        if (kind === "bindings" && isStringArray(body.data)) {
            this.bindings = new Set(body.data);
            this.syncReceiveFilter();
            return;
        }
        this.log?.debug({ kind, data: body.data }, "kurobot: 查询结果已记录");
    }

    /** 同步接收行过滤判定到 holder（绑定集变更后调用；私聊恒放行）。 */
    private syncReceiveFilter(): void {
        if (this.receiveFilter === undefined) {
            return;
        }
        this.receiveFilter.current = (peerUin, isGroup) => !isGroup || this.bindings.has(peerUin);
    }

    /** 发 chat 事件帧（无 id）。 */
    private sendChat(channel: string, sender: string, content: string): void {
        this.conn.send({ type: "chat", body: { channel, sender, content } });
    }

    /** 发 command 请求帧（登记 pending 表供 command_result 关联）。 */
    private sendCommand(channel: string, command: string, userId: string): void {
        const id = randomUUID();
        this.pendingCommands.set(id, channel);
        const sent = this.conn.send({
            type: "command",
            id,
            body: { command, source: { channel, userId } },
        });
        if (sent !== true) {
            this.pendingCommands.delete(id);
        }
    }

    /** 群文本发送（失败 error 日志不抛出——不影响连接与收链路）。 */
    private sendToGroup(channel: string, text: string): void {
        this.msgApi
            .sendMessage({ chatType: ChatType.GROUP, peerUid: channel }, [{ type: "text", text }])
            .then(() => {
                this.log?.debug({ channel }, "kurobot: 群消息已发送");
            })
            .catch((err: unknown) => {
                this.log?.error(
                    { channel, err: err instanceof Error ? err.message : String(err) },
                    "kurobot: 群消息发送失败",
                );
            });
    }

    /** 订阅 kernel 消息事件（幂等）。 */
    subscribe(): void {
        if (this.unsubscribe !== null) {
            return;
        }
        this.unsubscribe = this.msgChannel.on("Msg/onRecvMsg", (msgs) => {
            forEachRawMessage(msgs, (msg) => {
                this.handleIncomingMessage(msg);
            });
        });
    }

    /** 退订（幂等）。 */
    private unsubscribeAll(): void {
        this.unsubscribe?.();
        this.unsubscribe = null;
    }
}

/** string[] 防御性收窄（query_result bindings data）。 */
function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === "string");
}
