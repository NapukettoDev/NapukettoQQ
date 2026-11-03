/**
 * 适配器注册表：cli 按 enabledProtocols 装配用。
 */

/** 协议适配器基类类型（避免 core 与具体协议循环依赖的轻量接口）。 */
export interface ProtocolAdapterLike {
    readonly protocol: string;
    start: () => Promise<void>;
    stop: () => Promise<void>;
}

export class AdapterRegistry {
    private readonly adapters = new Map<string, ProtocolAdapterLike>();

    register(adapter: ProtocolAdapterLike): void {
        this.adapters.set(adapter.protocol, adapter);
    }

    get(protocol: string): ProtocolAdapterLike | undefined {
        return this.adapters.get(protocol);
    }

    async startAll(): Promise<void> {
        await Promise.all([...this.adapters.values()].map((a) => a.start()));
    }

    async stopAll(): Promise<void> {
        await Promise.all([...this.adapters.values()].map((a) => a.stop()));
    }
}
