/**
 * BaseProtocolAdapter：协议适配器骨架（只写一次，各协议薄映射）
 *
 * 生命周期：start（校验配置 → 协议层初始化 → 启动传输）→ stop。
 * 请求分发：协议层把 network 的 onRequest 绑定到 `handleRequest`。
 * 事件广播：协议层翻译 kernel 事件后经 `broadcastEvent` 推给 network。
 */

import { ConfigBase, type ConfigSchema, isRecord } from "@napuketto/kernel";
import { EventBroadcaster } from "@napuketto/network";

/**
 * 协议配置输入：`ConfigBase` 实例（loader seed 装配）或 Plain Object（嵌入式
 * 调用方最常写的形态）。`undefined` = 全空配置（schema 缺省值兜底）。
 */
export type ProtocolConfigInput<TConfig> =
    | ConfigBase<TConfig>
    | Partial<TConfig>
    | Record<string, unknown>
    | undefined;

/** 是否为 ConfigBase 实例/鸭子类型（单测常注入带 `load()` 的 mock）。 */
function isConfigBaseLike<TConfig>(value: unknown): value is ConfigBase<TConfig> {
    return isRecord(value) && typeof value["load"] === "function";
}

/**
 * 解析协议配置，消除「必须先 new ProtocolConfig(...)」的装配门槛：
 *  - 传入 ConfigBase 实例（或带 `load()` 的鸭子类型）→ 原样透传；
 *  - 传入 Plain Object / undefined → 自动包装成内存 seed 的 ConfigBase
 *    （`path: "<inline>"`，不读盘不写盘，schema 校验 + 缺省值兜底）。
 *
 * @param configOrInput 配置实例 / 普通配置对象 / undefined
 * @param schema 协议 zod schema
 * @param defaults 缺省值（通常 `schema.parse({})`）
 */
export function resolveProtocolConfig<TConfig>(
    configOrInput: ProtocolConfigInput<TConfig>,
    schema: ConfigSchema<TConfig>,
    defaults: TConfig,
): ConfigBase<TConfig> {
    if (isConfigBaseLike<TConfig>(configOrInput)) {
        return configOrInput;
    }
    return new ConfigBase<TConfig>({
        path: "<inline>",
        schema,
        defaults,
        seed: schema.parse(configOrInput ?? {}),
    });
}

/**
 * 适配器生命周期钩子：由协议层实现（配置校验、初始化、资源清理）。
 * @typeParam TConfig - 协议配置类型（与 BaseProtocolAdapter 的 TConfig 对齐，
 * onStart/onReload 强类型透传，协议层不再手动收窄）
 */
export interface ProtocolHooks<TConfig = unknown> {
    /** 配置校验通过后初始化（如建立 kernel 事件订阅）。 */
    onStart: (config: TConfig) => Promise<void>;
    /** 停止时清理资源（退订、关闭传输等）。 */
    onStop: () => Promise<void>;
    /** 配置热更新。 */
    onReload: (config: TConfig) => Promise<void>;
}

/**
 * 协议适配器骨架。
 * @typeParam TConfig - 协议配置类型
 */
export abstract class BaseProtocolAdapter<TConfig> {
    abstract readonly protocol: string;

    protected readonly config: ConfigBase<TConfig>;
    protected readonly hooks: ProtocolHooks<TConfig>;
    private readonly broadcaster: EventBroadcaster | undefined;
    private started = false;
    /** 进行中的 start（并发调用去重，复用同一次初始化）。 */
    private startPromise: Promise<void> | null = null;
    /** 进行中的 stop（并发调用去重）。 */
    private stopPromise: Promise<void> | null = null;

    constructor(opts: {
        config: ConfigBase<TConfig>;
        hooks: ProtocolHooks<TConfig>;
        broadcaster?: EventBroadcaster | undefined;
    }) {
        this.config = opts.config;
        this.hooks = opts.hooks;
        // 缺省内部广播器：嵌入式调用方不必显式装配（传输注册后自然生效）。
        this.broadcaster = opts.broadcaster ?? new EventBroadcaster();
    }

    /** 启动：加载配置 → 校验 → 协议层初始化（幂等；并发调用共享同一次初始化）。 */
    async start(): Promise<void> {
        if (this.stopPromise !== null) {
            // stop 进行中：等清理落地（重启动语义，避免与 stop 交错）
            await this.stopPromise;
        }
        if (this.started) {
            return;
        }
        if (this.startPromise !== null) {
            await this.startPromise;
            return;
        }
        const run = (async () => {
            const config = await this.config.load();
            await this.hooks.onStart(config);
            this.started = true;
        })();
        this.startPromise = run;
        try {
            await run;
        } finally {
            this.startPromise = null;
        }
    }

    /** 停止：协议层清理资源（幂等；并发调用共享同一次清理；start 进行中先等其落地）。 */
    async stop(): Promise<void> {
        if (this.startPromise !== null) {
            // start 进行中：等它落地（失败 = 无资源需清理，走下方 started 判断）
            await this.startPromise.catch(() => undefined);
        }
        if (!this.started) {
            return;
        }
        if (this.stopPromise !== null) {
            await this.stopPromise;
            return;
        }
        const run = (async () => {
            await this.hooks.onStop();
            this.started = false;
        })();
        this.stopPromise = run;
        try {
            await run;
        } finally {
            this.stopPromise = null;
        }
    }

    /**
     * 配置热更新：重新加载 → 校验 → 协议层处理。
     * 未 start 时 no-op：onReload 的实现假定实例已在运行（先停旧传输再按新配置
     * 重建），对未启动实例执行会留下「传输已启动但 started=false、后续 stop() 空转」
     * 的状态不一致——热更新语义只对运行中实例成立。
     */
    async reload(): Promise<void> {
        if (!this.started) {
            return;
        }
        // ConfigBase.reload() 原为 load() 的别名（已在 kernel 侧作为死代码删除），
        // 热更新语义即重新 load，行为不变。
        const config = await this.config.load();
        await this.hooks.onReload(config);
    }

    /** 广播协议事件给所有 network 适配器。 */
    protected broadcastEvent<T>(event: T): void {
        this.broadcaster?.emit(event);
    }

    /** 获取广播器（传输装配等内部使用；缺省返回内部实例）。 */
    protected getBroadcaster(): EventBroadcaster | undefined {
        return this.broadcaster;
    }

    /** 释放：等价 stop（幂等）。 */
    async dispose(): Promise<void> {
        await this.stop();
    }

    /** `await using adapter = ...` 自动释放。 */
    async [Symbol.asyncDispose](): Promise<void> {
        await this.stop();
    }
}
