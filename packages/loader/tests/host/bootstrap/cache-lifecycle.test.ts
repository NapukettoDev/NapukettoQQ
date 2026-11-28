import { expect, it } from "vitest";
import { stub } from "../../../../adapter/tests/internal/stub.js";
import {
    type AssemblyLifecycleDeps,
    type AssemblyShutdownHook,
    type AssemblyShutdownPhase,
    createAssemblyLifecycle,
} from "../../../src/host/bootstrap/assembly-lifecycle.js";
import type { KernelServices } from "../../../src/host/runtime/service-types.js";

type Hooks = Record<AssemblyShutdownPhase, AssemblyShutdownHook[]>;

interface ShutdownState {
    shuttingDown: boolean;
}

/** 每代装配面用登录 uin 标记，停止函数据此记录清理代次。 */
function servicesFixture(calls: string[], uin: string): KernelServices {
    return stub<KernelServices>({
        self: { uin, nickname: `fixture-${uin}`, uid: `u_${uin}` },
        dispose: () => {
            calls.push(`services-${uin}`);
        },
        stopAdapters: async () => {
            calls.push(`adapters-${uin}`);
        },
    });
}

function baseDeps(
    calls: string[],
    state: ShutdownState,
): Omit<AssemblyLifecycleDeps, "registerShutdownHook"> {
    return {
        startProtocols: async (loginResult) => servicesFixture(calls, loginResult.uin),
        attachIpcServices: (services) => {
            const uin = services.self.uin;
            return () => {
                calls.push(`ipc-${uin}`);
            };
        },
        attachOb11IpcBridge: async (services) => {
            const uin = services.self.uin;
            return () => {
                calls.push(`ob11-${uin}`);
            };
        },
        isShuttingDown: () => state.shuttingDown,
    };
}

function recordHooks(): {
    hooks: Hooks;
    register: NonNullable<AssemblyLifecycleDeps["registerShutdownHook"]>;
} {
    const hooks: Hooks = { protocols: [], services: [] };
    return {
        hooks,
        register: (hook, phase) => {
            hooks[phase].push(hook);
            return () => undefined;
        },
    };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
    let settle: ((value: T) => void) | undefined;
    const promise = new Promise<T>((resolve) => {
        settle = resolve;
    });
    return {
        promise,
        resolve: (value) => {
            if (settle === undefined) {
                throw new Error("deferred 未初始化");
            }
            settle(value);
        },
    };
}

async function runShutdownPhase(hooks: Hooks, phase: AssemblyShutdownPhase): Promise<void> {
    for (const hook of hooks[phase]) {
        await hook();
    }
}

it("软重登与关停均先停协议消费方，再释放缓存所属的服务", async () => {
    const calls: string[] = [];
    const state: ShutdownState = { shuttingDown: false };
    const { hooks, register } = recordHooks();
    const lifecycle = createAssemblyLifecycle({
        ...baseDeps(calls, state),
        registerShutdownHook: register,
    });

    await expect(lifecycle.mount({ uin: "1", uid: "u1" }, async () => undefined)).resolves.toBe(
        true,
    );
    expect(hooks.protocols).toHaveLength(1);
    expect(hooks.services).toHaveLength(1);

    await expect(
        lifecycle.reassemble({ uin: "2", uid: "u2" }, async () => {
            calls.push("prepare-2");
        }),
    ).resolves.toBe(true);
    expect(calls).toEqual(["ob11-1", "adapters-1", "ipc-1", "services-1", "prepare-2"]);

    // 关停按真实阶段顺序落钩："protocols"（桥 + 适配器）先于 "services"（IPC + dispose）。
    await runShutdownPhase(hooks, "protocols");
    await runShutdownPhase(hooks, "services");
    expect(calls.slice(5)).toEqual(["ob11-2", "adapters-2", "ipc-2", "services-2"]);
});

it("startProtocols 异步返回时已关停：立即释放刚创建的服务且不挂载 IPC", async () => {
    const calls: string[] = [];
    const state: ShutdownState = { shuttingDown: false };
    const { register } = recordHooks();
    const started = deferred<void>();
    const startResult = deferred<KernelServices | null>();
    const services = servicesFixture(calls, "1");
    const lifecycle = createAssemblyLifecycle({
        ...baseDeps(calls, state),
        startProtocols: () => {
            started.resolve(undefined);
            return startResult.promise;
        },
        attachIpcServices: () => {
            calls.push("ipc-mounted");
            return () => undefined;
        },
        attachOb11IpcBridge: async () => {
            calls.push("ob11-mounted");
            return () => undefined;
        },
        registerShutdownHook: register,
    });

    const mounting = lifecycle.mount({ uin: "1", uid: "u1" }, async () => undefined);
    await started.promise;
    state.shuttingDown = true;
    startResult.resolve(services);

    await expect(mounting).resolves.toBe(false);
    expect(calls).toEqual(["adapters-1", "services-1"]);
});

it("attachOb11IpcBridge 异步返回时已关停：立刻停桥且不把桥留在装配面", async () => {
    const calls: string[] = [];
    const state: ShutdownState = { shuttingDown: false };
    const { hooks, register } = recordHooks();
    const bridgeStarted = deferred<void>();
    const bridgeResult = deferred<() => void>();
    const lifecycle = createAssemblyLifecycle({
        ...baseDeps(calls, state),
        attachOb11IpcBridge: () => {
            bridgeStarted.resolve(undefined);
            return bridgeResult.promise;
        },
        registerShutdownHook: register,
    });

    const mounting = lifecycle.mount({ uin: "1", uid: "u1" }, async () => undefined);
    await bridgeStarted.promise;
    state.shuttingDown = true;
    bridgeResult.resolve(() => {
        calls.push("ob11-1");
    });

    await expect(mounting).resolves.toBe(false);
    expect(calls).toEqual(["ob11-1"]);

    await runShutdownPhase(hooks, "protocols");
    await runShutdownPhase(hooks, "services");
    expect(calls).toEqual(["ob11-1", "adapters-1", "ipc-1", "services-1"]);
});

it("stopOb11Bridge 或 stopIpcServices 抛错时 finally 仍继续释放适配器与缓存服务", async () => {
    const calls: string[] = [];
    const state: ShutdownState = { shuttingDown: false };
    const { hooks, register } = recordHooks();
    const lifecycle = createAssemblyLifecycle({
        ...baseDeps(calls, state),
        attachIpcServices: () => () => {
            calls.push("ipc-1");
            throw new Error("ipc stop failed");
        },
        attachOb11IpcBridge: async () => () => {
            calls.push("ob11-1");
            throw new Error("ob11 stop failed");
        },
        registerShutdownHook: register,
    });
    await expect(lifecycle.mount({ uin: "1", uid: "u1" }, async () => undefined)).resolves.toBe(
        true,
    );

    const stopProtocols = hooks.protocols[0];
    const disposeServices = hooks.services[0];
    if (stopProtocols === undefined || disposeServices === undefined) {
        throw new Error("关停钩子未注册");
    }

    await expect(Promise.resolve(stopProtocols())).rejects.toThrow("ob11 stop failed");
    expect(calls).toEqual(["ob11-1", "adapters-1"]);

    expect(() => disposeServices()).toThrow("ipc stop failed");
    expect(calls).toEqual(["ob11-1", "adapters-1", "ipc-1", "services-1"]);
});
