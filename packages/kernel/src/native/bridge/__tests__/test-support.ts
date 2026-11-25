/**
 * bridge 测试公共设施（msg/group/friend/login/recent-contact 桥共用）：
 * 桩原生 service（捕获注册的 listener 对象 + 可控 listenerId）与桩 session。
 * 绝不加载真实 wrapper.node——桥只依赖「普通 JS 对象 + getter」这一运行时事实。
 */
import type { Mock } from "vitest";
import { vi } from "vitest";

/** 桩 service 结果：add 方法捕获 listener，remove 记录调用。 */
export interface CapturedService<L> {
    service: Record<string, Mock>;
    /** 当前注册的 listener 对象（register 后可取到）。 */
    listener: () => L | undefined;
}

/** 构造捕获 listener 的桩 service（addName 返回固定 listenerId）。 */
export function makeCapturedService<L>(
    addName: string,
    removeName: string,
    listenerId = 42,
): CapturedService<L> {
    let captured: L | undefined;
    const service: Record<string, Mock> = {
        [addName]: vi.fn((l: L) => {
            captured = l;
            return listenerId;
        }),
        [removeName]: vi.fn(),
    };
    return { service, listener: () => captured };
}

/** 构造桩 session：getterName 对应的 getter 返回 service。 */
export function makeSession(getterName: string, service: unknown): unknown {
    return { [getterName]: () => service };
}
