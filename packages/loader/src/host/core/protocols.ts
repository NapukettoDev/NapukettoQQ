/**
 * protocols.ts：协议装配入口（登录成功后）。
 * 2026-08-08 重构：kernel 服务创建 → kernel-services.ts；OB11/Satori 装配 →
 * assemble-protocols.ts。本文件只留入口 + IPC 模式分支。
 *
 * 分支：
 *  - IPC 模式（NAPUKETTO_IPC=1，koishi 插件驱动）：跳过 OB11/Satori（插件直接消费
 *    kernel 服务），返回 KernelServices 由 bootstrap 装配 ipc-server。
 *  - 非 IPC（cli pnpm start）：照旧装配 OB11/Satori 网络传输。
 */
import { isShuttingDown, registerShutdownHook } from "../../lifecycle/shutdown.js";
import { env, isEnvEnabled } from "../env.js";
import type { CoreContextLike, KernelLike, LogConfigLike, LoginResultLike } from "../types.js";
import { errMsg, isConfigError, log, logFatal } from "../util.js";
import { assembleOb11AndSatori } from "./assemble-protocols.js";
import { createKernelServices, type KernelServices } from "./kernel-services.js";

export type { KernelServices } from "./kernel-services.js";

/**
 * 登录成功后装配协议：IPC 模式返回 kernel 服务（供 ipc-server），否则装配 OB11/Satori。
 *
 * 返回 null = 服务未装配（session 缺失 / OB11/Satori 装配失败）——调用方据此判
 * 引导失败。env 未注入 adapter/network 入口时「跳过装配」仍返回服务（合法运行形态，
 * 如纯 kernel 探测），不算失败。logCfg 为日志配置（loader logger 构造与接收行
 * 过滤用，2026-10-25）。
 */
export async function startProtocols(
    kernel: KernelLike,
    ctx: CoreContextLike,
    loginResult: LoginResultLike,
    logCfg?: LogConfigLike,
): Promise<KernelServices | null> {
    const services = await createKernelServices(kernel, ctx, loginResult, logCfg);
    if (services === null) {
        return null;
    }
    if (isShuttingDown()) {
        services.dispose();
        return null;
    }
    if (isEnvEnabled(env.NAPUKETTO_IPC)) {
        log("bootstrap: IPC 模式，跳过 OB11/Satori 装配（koishi 插件直接消费 kernel 服务）");
        return services;
    }
    const unregister = registerShutdownHook(() => services.dispose());
    try {
        services.stopAdapters = await assembleOb11AndSatori(kernel, services, loginResult);
    } catch (e) {
        services.dispose();
        // 配置校验失败重抛（ConfigError 契约，2026-10-25）：沿 bootstrap 链传给
        // self-host 以 78 退出（宿主免重启），由 exitOnBootstrapError 统一输出原因；
        // 其余装配失败仍收敛为 null 判引导失败——此处先落 file + stderr 留痕，
        // 否则 Docker 只看到 code=1 却没有任何错误（issue #144）。
        if (isConfigError(e)) {
            throw e;
        }
        logFatal(`bootstrap: 协议装配失败: ${errMsg(e)}`);
        return null;
    } finally {
        unregister();
    }
    return services;
}
