/**
 * NapukettoKurobotAdapter：kurobot-ws 协议适配器（KuroBot MVP-3，2026-09-13）
 *
 * - 出链路：订阅 kernel 消息事件通道 → 仅群聊 → 富文本降级 → 出站绑定过滤 →
 *   kurobot-ws chat 帧；命令前缀消息 → command 帧（source 由本侧提取）。
 * - 入链路：KurobotConnection 收服务端帧 → chat/join/leave/death 渲染模板 →
 *   kernel 群消息 API 纯文本发送；status 仅缓存；command_result 经 pending 表
 *   关联回发群（帧无 channel 字段，靠请求 UUID 关联）。
 *
 * 生命周期走 BaseProtocolAdapter 骨架（start 校验配置 → onStart 建连接 + 订阅 →
 * onStop 清理）；连接层状态机见 connection.ts。不发协议事件给 network 广播器
 * （kurobot 是纯客户端出向协议，无第三方接入门面）。
 */
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { CanonicalElement, MsgEventChannel, Peer, RawMessage } from "@napuketto/kernel";
import { ChatType } from "@napuketto/kernel";
import { BaseProtocolAdapter, type ProtocolConfig } from "../core/index.js";
import { forEachRawMessage } from "../core/raw-message.js";
import type { KurobotConfig } from "./config.js";
import type {
    ConnectionEndedReason,
    KurobotConnectionOptions,
    ServerEventMessage,
} from "./connection.js";
import { KurobotConnection } from "./connection.js";
import { type HelloAckOkBody, PROTOCOL_VERSION, type StatusBody } from "./schema.js";
import {
    degradeMessage,
    renderCommandResult,
    renderDeathText,
    renderTemplate,
    resolveSenderName,
    truncateForGroup,
} from "./translate.js";

/** 发群消息最小面（kernel MsgApi.sendMessage 的结构子集，便于测试桩替换）。 */
export interface KurobotMsgApi {
    sendMessage(target: Peer, elements: CanonicalElement[]): Promise<{ msgId: string }>;
}

/** 适配器构造参数。 */
export interface KurobotAdapterOptions {
    /** 协议配置（zod 校验 + seed 装配）。 */
    config: ProtocolConfig<KurobotConfig>;
    /** kernel 消息事件通道（QQ 消息收链路入口）。 */
    msgChannel: MsgEventChannel;
    /** kernel 消息 API（MC → QQ 群文本发送）。 */
    msgApi: KurobotMsgApi;
    /** 当前登录账号（自消息过滤 + hello peerId）。 */
    self: { uin: string; nickname: string };
    /** 日志（缺省静默）。 */
    logger?: KurobotLoggerAlias;
}

/** 适配器日志面（复用连接层最小面）。 */
type KurobotLoggerAlias = KurobotConnectionOptions["logger"];

/** kurobot 协议适配器。 */
export class NapukettoKurobotAdapter extends BaseProtocolAdapter<KurobotConfig> {
    readonly protocol = "kurobot";

    private readonly msgChannel: MsgEventChannel;
    private readonly msgApi: KurobotMsgApi;
    private readonly selfUin: string;
    private readonly log: KurobotLoggerAlias;
    private connection: KurobotConnection | null = null;
    private unsubscribe: (() => void) | null = null;
    /** 当前生效配置（收链路取 commandPrefix 等；onStart/onReload 刷新）。 */
    private currentConfig: KurobotConfig | null = null;
    /** 出站绑定集（hello_ack 快照 + bindings_updated 全量替换；空集 = 全部不发）。 */
    private bindings = new Set<string>();
    /** command 请求 UUID → 回发群号（command_result 帧无 channel，靠 id 关联）。 */
    private pendingCommands = new Map<string, string>();
    /** query 请求 UUID → 查询类别。 */
    private pendingQueries = new Map<string, "status" | "bindings">();
    /** 最近一帧 status 快照（仅缓存不发群，M-04 决策同构）。 */
    private lastStatus: StatusBody | null = null;

    constructor(opts: KurobotAdapterOptions) {
        super({
            config: opts.config,
            hooks: {
                onStart: (config) => this.startKurobot(config as KurobotConfig),
                onStop: () => this.stopAll(),
                onReload: (config) => this.reloadKurobot(config as KurobotConfig),
            },
        });
        this.msgChannel = opts.msgChannel;
        this.msgApi = opts.msgApi;
        this.selfUin = String(opts.self.uin);
        this.log = opts.logger;
    }

    /** 最近一帧 status 快照（仅缓存；无帧时 null）。 */
    getLastStatus(): StatusBody | null {
        return this.lastStatus;
    }

    /** 连接是否已建立（hello_ack ok 后为 true）。 */
    isConnected(): boolean {
        return this.connection?.isEstablished() ?? false;
    }

    /** 发起 query 请求（status/bindings）。MVP 未接 QQ 触发面——预留能力（见 design.md §8）。 */
    query(kind: "status" | "bindings"): boolean {
        const conn = this.connection;
        if (conn === null || !conn.isEstablished()) {
            return false;
        }
        const id = randomUUID();
        this.pendingQueries.set(id, kind);
        return conn.send({ type: "query", id, body: { kind } });
    }

    /** 启动：建连接（异步握手，日志可见）+ 订阅 kernel 消息。 */
    private async startKurobot(config: KurobotConfig): Promise<void> {
        this.currentConfig = config;
        this.bindings = new Set();
        this.pendingCommands.clear();
        this.pendingQueries.clear();
        this.lastStatus = null;
        const hello: KurobotConnectionOptions["hello"] = {
            peerId: this.selfUin,
            platform: "qq",
            version: resolveAdapterVersion(),
            protocolVersion: PROTOCOL_VERSION,
            client: config.client ?? resolveDefaultClient(),
        };
        if (config.token !== "") {
            hello.token = config.token;
        }
        const connOptions: KurobotConnectionOptions = {
            url: config.url,
            hello,
            pingIntervalMs: config.pingIntervalMs,
            helloTimeoutMs: 10_000,
            retryBaseDelayMs: 1_000,
            retryMaxDelayMs: 60_000,
            onEstablished: (ack) => this.onEstablished(ack),
            onFrame: (msg) => this.onServerFrame(msg),
            onEnded: (reason) => this.onEnded(reason),
        };
        if (this.log !== undefined) {
            connOptions.logger = this.log;
        }
        this.connection = new KurobotConnection(connOptions);
        this.connection.start();
        this.subscribe();
    }

    /** 配置热更新：停旧连接/退订 → 按新配置重建（对齐 satori reloadTransports）。 */
    private async reloadKurobot(config: KurobotConfig): Promise<void> {
        await this.stopAll();
        await this.startKurobot(config);
    }

    /** 停止：退订 + 关连接 + 清 pending 表。 */
    private async stopAll(): Promise<void> {
        this.unsubscribeAll();
        this.connection?.stop();
        this.connection = null;
        this.pendingCommands.clear();
        this.pendingQueries.clear();
    }

    /** 握手成功：绑定集整体替换为服务端快照 + 清上一连接的 pending 表。 */
    private onEstablished(ack: HelloAckOkBody): void {
        this.pendingCommands.clear();
        this.pendingQueries.clear();
        this.bindings = new Set(ack.channelBindings);
    }

    /** 连接永久停止（1002/1008/hello_ack 拒绝）：清 pending（绑定集留给下次握手覆盖）。 */
    private onEnded(reason: ConnectionEndedReason): void {
        this.pendingCommands.clear();
        this.pendingQueries.clear();
        this.log?.error({ reason }, "kurobot: 连接终止");
    }

    /** 服务端帧分发（渲染回群 / 缓存 / 绑定集维护 / 命令结果关联回发）。 */
    private onServerFrame(msg: ServerEventMessage): void {
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
            return;
        }
        this.log?.debug({ kind, data: body.data }, "kurobot: 查询结果已记录");
    }

    /** kernel 群消息 → kurobot 出站（仅群聊 + 自消息过滤 + 命令分流 + 绑定过滤）。 */
    private handleIncomingMessage(msg: RawMessage): void {
        const config = this.currentConfig;
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

    /** 发 chat 事件帧（无 id）。 */
    private sendChat(channel: string, sender: string, content: string): void {
        this.connection?.send({ type: "chat", body: { channel, sender, content } });
    }

    /** 发 command 请求帧（登记 pending 表供 command_result 关联）。 */
    private sendCommand(channel: string, command: string, userId: string): void {
        const id = randomUUID();
        this.pendingCommands.set(id, channel);
        const sent = this.connection?.send({
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

    /** 当前生效配置（收链路保证已 start）。 */
    private requireConfig(): KurobotConfig {
        const config = this.currentConfig;
        if (config === null) {
            throw new Error("kurobot: 配置未初始化（适配器未启动）");
        }
        return config;
    }

    /** 订阅 kernel 消息事件（幂等）。 */
    private subscribe(): void {
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

/** best-effort 读取 adapter 包版本（dist 与 src 双布局相对包根一致）。 */
function resolvePackageVersion(): string | null {
    try {
        const require = createRequire(import.meta.url);
        const pkg = require("../../package.json") as { version?: unknown };
        if (typeof pkg.version === "string" && pkg.version !== "") {
            return pkg.version;
        }
        return null;
    } catch {
        return null;
    }
}

/** hello.version：adapter 包版本（取不到用 unknown）。 */
function resolveAdapterVersion(): string {
    return resolvePackageVersion() ?? "unknown";
}

/** hello.client 缺省身份：napukettoqq/<版本>（取不到版本则 napukettoqq）。 */
function resolveDefaultClient(): string {
    const version = resolvePackageVersion();
    return version === null ? "napukettoqq" : `napukettoqq/${version}`;
}
