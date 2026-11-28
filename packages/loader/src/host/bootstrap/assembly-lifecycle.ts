/**
 * assembly-lifecycle.ts：一套装配面的挂载/销毁生命周期（协议服务 → IPC 转发 → OB11 桥）。
 * 关停钩子按阶段拆分："protocols" 只停协议消费方（OB11 桥 → 网络适配器），
 * "services" 再释放 IPC 转发与 kernel 服务（桥/缓存/消息日志 dispose）。
 * 软重登先停旧装配面再挂载新面；任一步异步返回时若已进入关停，立即回滚刚创建/挂载的资源。
 */
import { isShuttingDown, registerShutdownHook } from "../../lifecycle/shutdown.js";
import { log } from "../../shared/boot-log.js";
import type { KernelServices } from "../runtime/service-types.js";
import type { LoginResultLike } from "../runtime/types.js";

/** 本单元参与的两个关停阶段（协议消费方先于缓存服务）。 */
export type AssemblyShutdownPhase = "protocols" | "services";

/** 关停钩子（与 lifecycle/shutdown.ts 的 ShutdownHook 同构）。 */
export type AssemblyShutdownHook = () => void | Promise<void>;

/** 装配生命周期协作者（最小面；关停探测与钩子注册缺省接真实实现）。 */
export interface AssemblyLifecycleDeps {
    /** 为一次登录结果启动协议服务；null = 装配失败。 */
    startProtocols(loginResult: LoginResultLike): Promise<KernelServices | null>;
    /** 挂载 IPC 事件转发与动作表，返回停止函数。 */
    attachIpcServices(services: KernelServices): () => void;
    /** 挂载 OB11 IPC 动作桥，返回停止函数。 */
    attachOb11IpcBridge(services: KernelServices): Promise<() => void>;
    /** 关停哨兵（缺省 lifecycle/shutdown.ts）。 */
    isShuttingDown?(): boolean;
    /** 关停钩子注册（缺省 lifecycle/shutdown.ts）。 */
    registerShutdownHook?(hook: AssemblyShutdownHook, phase: AssemblyShutdownPhase): () => void;
}

/** 装配面生命周期：跨登录代复用同一个实例（关停钩子只注册一次）。 */
export interface AssemblyLifecycle {
    /**
     * 挂载一套新装配面：`prepare` 完成 session 准备 → 协议服务 → IPC 转发 → OB11 桥。
     * 关停竞态下不发布新装配面，返回 false。
     */
    mount(loginResult: LoginResultLike, prepare: () => Promise<void>): Promise<boolean>;
    /**
     * 软重登重装配：先停旧装配面（协议消费方 → 缓存服务），再准备 session 并挂载新面。
     * 清理后已进入关停时返回 false。
     */
    reassemble(loginResult: LoginResultLike, prepare: () => Promise<void>): Promise<boolean>;
}

/** 创建装配面生命周期（bootstrap/core 在 attachWrapper 后持有）。 */
export function createAssemblyLifecycle(deps: AssemblyLifecycleDeps): AssemblyLifecycle {
    const shuttingDown = deps.isShuttingDown ?? isShuttingDown;
    const register: (hook: AssemblyShutdownHook, phase: AssemblyShutdownPhase) => () => void =
        deps.registerShutdownHook ?? registerShutdownHook;
    let services: KernelServices | null = null;
    let stopIpcServices: (() => void) | null = null;
    let stopOb11Bridge: (() => void) | null = null;

    async function stopProtocols(): Promise<void> {
        const stopBridge = stopOb11Bridge;
        stopOb11Bridge = null;
        try {
            stopBridge?.();
        } finally {
            await services?.stopAdapters?.();
        }
    }

    function disposeServices(): void {
        const stopIpc = stopIpcServices;
        const current = services;
        stopIpcServices = null;
        services = null;
        try {
            stopIpc?.();
        } finally {
            current?.dispose();
        }
    }

    register(stopProtocols, "protocols");
    register(disposeServices, "services");

    async function attachIpc(newServices: KernelServices): Promise<void> {
        stopIpcServices = deps.attachIpcServices(newServices);
        const stopBridge = await deps.attachOb11IpcBridge(newServices);
        if (shuttingDown()) {
            stopBridge();
        } else {
            stopOb11Bridge = stopBridge;
        }
    }

    async function mount(
        loginResult: LoginResultLike,
        prepare: () => Promise<void>,
    ): Promise<boolean> {
        await prepare();
        if (shuttingDown()) {
            return false;
        }
        const newServices = await deps.startProtocols(loginResult);
        if (newServices === null) {
            log("bootstrap: 协议服务装配失败，引导中止");
            return false;
        }
        if (shuttingDown()) {
            try {
                await newServices.stopAdapters?.();
            } finally {
                newServices.dispose();
            }
            return false;
        }
        services = newServices;
        await attachIpc(newServices);
        return !shuttingDown();
    }

    return {
        mount,
        async reassemble(loginResult, prepare) {
            try {
                await stopProtocols();
            } finally {
                disposeServices();
            }
            if (shuttingDown()) {
                return false;
            }
            return await mount(loginResult, prepare);
        },
    };
}
