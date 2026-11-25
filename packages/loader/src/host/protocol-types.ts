/**
 * protocol-types.ts：动态 import 的协议模块最小接口面（2026-11-25 从 types.ts 拆出）。
 *
 * 这些接口只描述「模块导出面」（adapter 子路径 / network 包 / kernel 包），与
 * `module-loader.ts` + `module-guards.ts` 成对使用：守卫在运行时收窄，类型在这里
 * 表达。放在独立文件是为了让 `types.ts` 保持 kernel 交互面单一主题，避免它继续
 * 膨胀成万能类型桶。
 */

/** adapter core 子路径最小面（ProtocolConfig 框架，动态 import）。 */
export interface AdapterCoreModuleLike {
    /** 历史别名（= ConfigBase，loader 动态 import 主用路径）。 */
    ProtocolConfig: new (
        options: Record<string, unknown>,
    ) => unknown;
    /** 新名字（与 ProtocolConfig 同值；保留可选以兼容旧 dist）。 */
    ConfigBase?: new (
        options: Record<string, unknown>,
    ) => unknown;
}

/** network 包最小面（EventBroadcaster，动态 import；register/unregister 为事件桥所需）。 */
export interface NetworkModuleLike {
    EventBroadcaster: new () => {
        register(adapter: { send: <T>(payload: T) => void }): unknown;
        unregister(adapter: { send: <T>(payload: T) => void }): void;
    };
}

/** adapter 包 satori 子路径最小面（@napuketto/adapter，动态 import）。 */
export interface SatoriModuleLike {
    satoriConfigSchema: { parse(input: unknown): unknown };
    NapukettoSatoriAdapter: new (
        options: Record<string, unknown>,
    ) => {
        start(): Promise<unknown>;
        stop(): Promise<void>;
    };
}

/** adapter 包 kurobot 子路径最小面（@napuketto/adapter，动态 import）。 */
export interface KurobotModuleLike {
    kurobotConfigSchema: { parse(input: unknown): unknown };
    kurobotConfigDefaults: () => unknown;
    NapukettoKurobotAdapter: new (
        options: Record<string, unknown>,
    ) => {
        start(): Promise<unknown>;
        stop(): Promise<void>;
    };
}

/** adapter 包 milky 子路径最小面（@napuketto/adapter，动态 import）。 */
export interface MilkyModuleLike {
    milkyConfigSchema: { parse(input: unknown): unknown };
    NapukettoMilkyAdapter: new (
        options: Record<string, unknown>,
    ) => {
        start(): Promise<unknown>;
        stop(): Promise<void>;
    };
}

/** OB11 动作最小面（handle 返回 OB11 信封 {status,retcode,data,message}，永不抛）。 */
export interface Ob11ActionLike {
    handle(payload: unknown): Promise<unknown>;
}

/** adapter 包 onebot11 子路径最小面（@napuketto/adapter，动态 import）。 */
export interface Ob11ModuleLike {
    ob11ConfigSchema: { parse(input: unknown): unknown };
    NapukettoOneBot11Adapter: new (
        options: Record<string, unknown>,
    ) => {
        start(): Promise<unknown>;
        stop(): Promise<void>;
        subscribeOnly(): Promise<void>;
        unsubscribeOnly(): void;
        registry: {
            names: string[];
            get(name: string): Ob11ActionLike | undefined;
        };
    };
}
