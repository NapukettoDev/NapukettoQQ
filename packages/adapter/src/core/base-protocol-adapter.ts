/**
 * BaseProtocolAdapter：协议适配器骨架（ADR-013，只写一次，各协议薄映射）
 *
 * 生命周期：start（校验配置 → 协议层初始化 → 启动传输）→ stop。
 * 请求分发：协议层把 network 的 onRequest 绑定到 `handleRequest`。
 * 事件广播：协议层翻译 kernel 事件后经 `broadcastEvent` 推给 network。
 */
import type { EventBroadcaster } from "@napuketto/network";
import type { ProtocolConfig } from "./config.js";

/** 适配器生命周期钩子：由协议层实现（配置校验、初始化、资源清理）。 */
export interface ProtocolHooks {
    /** 配置校验通过后初始化（如建立 kernel 事件订阅）。 */
    onStart: (config: unknown) => Promise<void>;
    /** 停止时清理资源（退订、关闭传输等）。 */
    onStop: () => Promise<void>;
    /** 配置热更新。 */
    onReload: (config: unknown) => Promise<void>;
}

/**
 * 协议适配器骨架。
 * @typeParam TConfig - 协议配置类型
 */
export abstract class BaseProtocolAdapter<TConfig> {
    abstract readonly protocol: string;

    protected readonly config: ProtocolConfig<TConfig>;
    protected readonly hooks: ProtocolHooks;
    private readonly broadcaster: EventBroadcaster | undefined;
    private started = false;

    constructor(opts: {
        config: ProtocolConfig<TConfig>;
        hooks: ProtocolHooks;
        broadcaster?: EventBroadcaster;
    }) {
        this.config = opts.config;
        this.hooks = opts.hooks;
        this.broadcaster = opts.broadcaster;
    }

    /** 启动：加载配置 → 校验 → 协议层初始化。 */
    async start(): Promise<void> {
        if (this.started) {
            return;
        }
        const config = await this.config.load();
        await this.hooks.onStart(config);
        this.started = true;
    }

    /** 停止：协议层清理资源。 */
    async stop(): Promise<void> {
        if (!this.started) {
            return;
        }
        await this.hooks.onStop();
        this.started = false;
    }

    /** 配置热更新：重新加载 → 校验 → 协议层处理。 */
    async reload(): Promise<void> {
        // ConfigBase.reload() 原为 load() 的别名（已在 kernel 侧作为死代码删除），
        // 热更新语义即重新 load，行为不变。
        const config = await this.config.load();
        await this.hooks.onReload(config);
    }

    /** 广播协议事件给所有 network 适配器。 */
    protected broadcastEvent<T>(event: T): void {
        this.broadcaster?.emit(event);
    }

    /** 获取广播器（传输装配等内部使用；未传入返回 undefined）。 */
    protected getBroadcaster(): EventBroadcaster | undefined {
        return this.broadcaster;
    }
}
