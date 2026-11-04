// biome-ignore-all lint/style/useNamingConvention: 对象键名为 QQ wrapper.node 真实导出名（PascalCase），必须原样保留
/**
 * wrapper 域测试公共设施：假 wrapper.node exports / WrapperContext 构造。
 * 全部为普通 JS 对象模拟 QQ 环境——绝不加载真实 wrapper.node / native 二进制。
 */
import { vi } from "vitest";
import type {
    NodeIQQNTWrapperEngine,
    NodeIQQNTWrapperSessionCtor,
    WrapperNodeApi,
} from "../../types/index.js";
import type { WrapperContext } from "../wrapper-loader.js";

/** 构造最小可用的 mock exports（overrides 宽松透传，模拟 QQ 环境）。 */
export function mockExports(overrides: Record<string, unknown> = {}): WrapperNodeApi {
    const engine = { initWithDeskTopConfig: vi.fn() };
    // session 构造器须可 new（createSession 最终兜底 new S()）
    const sessionCtor = Object.assign(
        function sessionCtor(this: unknown) {
            return {};
        },
        {
            get: () => null,
            getNTWrapperSession: () => null,
            create: () => null,
        },
    );
    const base = {
        NodeIQQNTWrapperEngine: { get: () => engine },
        NodeIQQNTWrapperSession: sessionCtor,
        NodeIQQNTStartupSessionWrapper: {
            create: () => ({ start: vi.fn(), getSessionIdList: () => new Map() }),
        },
        NodeQQNTWrapperUtil: {
            get: () => ({ getNTUserDataInfoConfig: () => null }),
        },
        NodeIKernelLoginService: {
            get: () => null,
        },
    };
    return { ...base, ...overrides } as unknown as WrapperNodeApi;
}

/** 构造 WrapperContext 便捷函数（engine 类型宽松断言）。 */
export function makeCtx(exports: WrapperNodeApi): WrapperContext {
    const engine = (
        exports.NodeIQQNTWrapperEngine as unknown as {
            get: () => NodeIQQNTWrapperEngine;
        }
    ).get();
    return {
        exports,
        engine,
        versionInfo: { fullVersion: "9.9.31-49919", buildVersion: "49919" },
        session: null,
        startupSession: null,
        loginService: null,
    };
}

/** Session 构造器 mock：create 兜底返回传入的 session（不依赖 new 构造）。 */
export function sessionCtorMock(session: unknown): NodeIQQNTWrapperSessionCtor {
    const ctor = vi.fn(() => session) as unknown as NodeIQQNTWrapperSessionCtor;
    Object.assign(ctor, {
        get: () => null,
        getNTWrapperSession: () => null,
        create: () => session,
    });
    return ctor;
}
