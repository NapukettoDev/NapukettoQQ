/**
 * NapukettoKurobotAdapter：kurobridge-ws 协议适配器（KuroBot MVP-3，2026-09-13）
 *
 * 出链路：kernel 群消息 → 降级 → 绑定过滤 → chat/command 帧；入链路：服务端帧
 * → 模板渲染 → kernel 群文本发送。本类只做协调（构造装配 / 连接建立与启停 /
 * 公共查询面）：订阅接线在 event-pipeline.ts，域处理在 inbound/，共享状态在
 * session.ts。纯客户端出向协议，不发协议事件给 network 广播器。
 */
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { CanonicalElement, MsgEventChannel, Peer } from "@napuketto/kernel";
import { BaseProtocolAdapter, type ProtocolConfig } from "../core/index.js";
import type { KurobotConfig } from "./config.js";
import type { KurobotConnectionOptions } from "./connection.js";
import { KurobotConnection } from "./connection.js";
import { KurobotEventPipeline } from "./event-pipeline.js";
import { KurobotMessageHandler } from "./inbound/message.js";
import { KurobotServerFrameHandler } from "./inbound/server-frames.js";
import type { StatusBody } from "./schema.js";
import { PROTOCOL_VERSION } from "./schema.js";
import { KurobotSession } from "./session.js";

/** 发群消息最小面（kernel MsgApi.sendMessage 的结构子集，便于测试桩替换）。 */
export interface KurobotMsgApi {
    sendMessage(target: Peer, elements: CanonicalElement[]): Promise<{ msgId: string }>;
}

/** 接收行绑定过滤 holder（loader ReceiveLogFilter 同构契约）。 */
export interface ReceiveLogFilterHolder {
    current: ((peerUin: string, isGroup: boolean) => boolean) | null;
}

/** 连接出口面（adapter 持有连接生命周期；未建立连接时 send 恒 false / established 恒 false）。 */
export interface KurobotConnFace {
    send: (frame: { type: string; body: unknown; id?: string }) => boolean;
    isEstablished: () => boolean;
}

/** 适配器构造参数。 */
export interface KurobotAdapterOptions {
    config: ProtocolConfig<KurobotConfig>;
    msgChannel: MsgEventChannel;
    msgApi: KurobotMsgApi;
    self: { uin: string; nickname: string };
    /**
     * 接收行绑定过滤 holder（2026-10-25 P1-7）：握手/绑定表更新时填充 current
     * （群频道按绑定表判定，私聊恒放行），停止/终止时清空；与 loader msg-log
     * 的 ReceiveLogFilter 结构契约（adapter 包不依赖 loader，自研同构描述）。
     */
    receiveFilter?: ReceiveLogFilterHolder;
    /** 日志（缺省静默）。 */
    logger?: KurobotLoggerAlias;
}

/** 适配器日志面（复用连接层最小面）。 */
type KurobotLoggerAlias = KurobotConnectionOptions["logger"];

/** kurobot 协议适配器。 */
export class NapukettoKurobotAdapter extends BaseProtocolAdapter<KurobotConfig> {
    readonly protocol = "kurobot";

    private readonly selfUin: string;
    private readonly log: KurobotLoggerAlias;
    /** 会话共享状态（绑定集 / pending 表 / status 快照 / 接收过滤）。 */
    private readonly session: KurobotSession;
    /** QQ 消息 → 出站帧域处理（经 pipeline 订阅路由）。 */
    private readonly message: KurobotMessageHandler;
    /** 服务端帧 → QQ 文本域处理（连接回调直连）。 */
    private readonly frames: KurobotServerFrameHandler;
    private readonly pipeline: KurobotEventPipeline;
    private connection: KurobotConnection | null = null;
    /** 当前生效配置（收链路取 commandPrefix 等；onStart/onReload 刷新）。 */
    private currentConfig: KurobotConfig | null = null;

    constructor(opts: KurobotAdapterOptions) {
        super({
            config: opts.config,
            hooks: {
                onStart: (config) => this.startKurobot(config),
                onStop: () => this.stopAll(),
                onReload: (config) => this.reloadKurobot(config),
            },
        });
        this.selfUin = String(opts.self.uin);
        this.log = opts.logger;
        const conn: KurobotConnFace = {
            send: (frame) => this.connection?.send(frame) === true,
            isEstablished: () => this.connection?.isEstablished() ?? false,
        };
        this.session = new KurobotSession({
            receiveFilter: opts.receiveFilter,
            logger: opts.logger,
        });
        this.message = new KurobotMessageHandler({
            selfUin: this.selfUin,
            currentConfig: () => this.currentConfig,
            conn,
            session: this.session,
            logger: opts.logger,
        });
        this.frames = new KurobotServerFrameHandler({
            msgApi: opts.msgApi,
            requireConfig: () => this.requireConfig(),
            session: this.session,
            logger: opts.logger,
        });
        this.pipeline = new KurobotEventPipeline({
            msgChannel: opts.msgChannel,
            message: this.message,
        });
    }

    /** 最近一帧 status 快照（仅缓存；无帧时 null）。 */
    getLastStatus(): StatusBody | null {
        return this.session.lastStatus;
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
        this.session.pendingQueries.set(id, kind);
        return conn.send({ type: "query", id, body: { kind } });
    }

    /** 启动：建连接（异步握手，日志可见）+ 订阅 kernel 消息。 */
    private async startKurobot(config: KurobotConfig): Promise<void> {
        this.currentConfig = config;
        this.session.resetForStart();
        const hello: KurobotConnectionOptions["hello"] = {
            peerId: this.selfUin,
            platform: "qq",
            version: resolvePackageVersion() ?? "unknown",
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
            onEstablished: (ack) => {
                // 握手成功：清上一连接 pending 表 + 绑定集整体替换为服务端快照
                this.session.clearPending();
                this.session.applyBindings(ack.channelBindings);
            },
            onFrame: (msg) => this.frames.handle(msg),
            onEnded: (reason) => {
                // 连接永久停止（1002/1008/hello_ack 拒绝）：清 pending 与接收过滤
                this.session.clearPending();
                this.session.clearReceiveFilter();
                this.log?.error({ reason }, "kurobot: 连接终止");
            },
        };
        if (this.log !== undefined) {
            connOptions.logger = this.log;
        }
        this.connection = new KurobotConnection(connOptions);
        this.connection.start();
        this.pipeline.subscribe();
    }

    /** 配置热更新：停旧连接/退订 → 按新配置重建（对齐 satori reloadTransports）。 */
    private async reloadKurobot(config: KurobotConfig): Promise<void> {
        await this.stopAll();
        await this.startKurobot(config);
    }

    /** 当前生效配置（收链路保证已 start）。 */
    private requireConfig(): KurobotConfig {
        const config = this.currentConfig;
        if (config === null) {
            throw new Error("kurobot: 配置未初始化（适配器未启动）");
        }
        return config;
    }

    /** 停止：退订 + 清 pending 表与接收过滤 + 关连接。 */
    private async stopAll(): Promise<void> {
        this.pipeline.unsubscribeAll();
        this.session.clearPending();
        this.session.clearReceiveFilter();
        this.connection?.stop();
        this.connection = null;
    }
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

/** hello.client 缺省身份：napukettoqq/<版本>（取不到版本则 napukettoqq）。 */
function resolveDefaultClient(): string {
    const version = resolvePackageVersion();
    return version === null ? "napukettoqq" : `napukettoqq/${version}`;
}
