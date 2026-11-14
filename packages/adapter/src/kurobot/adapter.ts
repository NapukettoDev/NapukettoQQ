/**
 * NapukettoKurobotAdapter：kurobridge-ws 协议适配器（KuroBot MVP-3，2026-09-13）
 *
 * 出链路：订阅 kernel 消息事件通道 → 仅群聊 → 富文本降级 → 出站绑定过滤 →
 * kurobridge-ws chat 帧；命令前缀消息 → command 帧。入链路：KurobotConnection
 * 收服务端帧 → 渲染模板 → kernel 群消息纯文本发送；status 仅缓存；command_result
 * 经 pending 表关联回发群。双向事件流在 event-pipeline.ts，本类只做协调
 * （构造装配 / 连接建立与启停 / 公共查询面）。不发协议事件给 network 广播器
 * （kurobot 是纯客户端出向协议，无第三方接入门户）。
 */
import { createRequire } from "node:module";
import type { CanonicalElement, MsgEventChannel, Peer } from "@napuketto/kernel";
import { BaseProtocolAdapter, type ProtocolConfig } from "../core/index.js";
import type { KurobotConfig } from "./config.js";
import type { KurobotConnectionOptions } from "./connection.js";
import { KurobotConnection } from "./connection.js";
import { KurobotEventPipeline } from "./event-pipeline.js";
import { PROTOCOL_VERSION, type StatusBody } from "./schema.js";

/** 发群消息最小面（kernel MsgApi.sendMessage 的结构子集，便于测试桩替换）。 */
export interface KurobotMsgApi {
    sendMessage(target: Peer, elements: CanonicalElement[]): Promise<{ msgId: string }>;
}

/** 接收行绑定过滤 holder（loader ReceiveLogFilter 同构契约）。 */
export interface ReceiveLogFilterHolder {
    current: ((peerUin: string, isGroup: boolean) => boolean) | null;
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
    /**
     * 接收行绑定过滤 holder（2026-10-25 P1-7）：握手/绑定表更新时填充 current
     * （群频道按绑定表判定，私聊恒放行）；停止/终止时清空（null = 不过滤）。
     * 与 loader msg-log 的 ReceiveLogFilter 结构契约（adapter 包不依赖 loader，
     * 自研同构描述）。
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
    /** 双向事件管道（订阅 / 过滤 / 绑定与 pending 状态 / 帧分发，2026-11-14 拆出）。 */
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
        this.pipeline = new KurobotEventPipeline({
            msgChannel: opts.msgChannel,
            msgApi: opts.msgApi,
            selfUin: this.selfUin,
            ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
            ...(opts.receiveFilter !== undefined ? { receiveFilter: opts.receiveFilter } : {}),
            currentConfig: () => this.currentConfig,
            requireConfig: () => this.requireConfig(),
            conn: {
                send: (frame) => this.connection?.send(frame) === true,
                isEstablished: () => this.connection?.isEstablished() ?? false,
            },
        });
    }

    /** 最近一帧 status 快照（仅缓存；无帧时 null）。 */
    getLastStatus(): StatusBody | null {
        return this.pipeline.getLastStatus();
    }

    /** 连接是否已建立（hello_ack ok 后为 true）。 */
    isConnected(): boolean {
        return this.connection?.isEstablished() ?? false;
    }

    /** 发起 query 请求（status/bindings）。MVP 未接 QQ 触发面——预留能力（见 design.md §8）。 */
    query(kind: "status" | "bindings"): boolean {
        return this.pipeline.query(kind);
    }

    /** 启动：建连接（异步握手，日志可见）+ 订阅 kernel 消息。 */
    private async startKurobot(config: KurobotConfig): Promise<void> {
        this.currentConfig = config;
        this.pipeline.resetForStart();
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
            onEstablished: (ack) => this.pipeline.onEstablished(ack),
            onFrame: (msg) => this.pipeline.onServerFrame(msg),
            onEnded: (reason) => this.pipeline.onEnded(reason),
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

    /** 停止：退订 + 关连接 + 清 pending 表。 */
    private async stopAll(): Promise<void> {
        this.pipeline.stop();
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

/** hello.version：adapter 包版本（取不到用 unknown）。 */
function resolveAdapterVersion(): string {
    return resolvePackageVersion() ?? "unknown";
}

/** hello.client 缺省身份：napukettoqq/<版本>（取不到版本则 napukettoqq）。 */
function resolveDefaultClient(): string {
    const version = resolvePackageVersion();
    return version === null ? "napukettoqq" : `napukettoqq/${version}`;
}
