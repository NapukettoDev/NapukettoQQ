/**
 * module-guards.ts：动态 `import()` 模块的运行时结构校验器。
 *
 * 背景（Step 3）：bootstrap / assemble-protocols / ipc-ob11 通过 file:// 动态
 * import kernel / adapter / network，返回类型是 `unknown`。此前用
 * `as unknown as *ModuleLike` 暴力收窄——模块缺导出时运行期才炸。这里以方法面
 * 守卫收窄，失败走显式错误（不静默）。
 */

import { hasCallableProp, hasMethodSurface, isRecord } from "../internal/type-guards.js";
import type {
    AdapterCoreModuleLike,
    KernelLike,
    KurobotModuleLike,
    MilkyModuleLike,
    NetworkModuleLike,
    Ob11ModuleLike,
    SatoriModuleLike,
} from "./types.js";

/** kernel 模块：至少提供一条装配入口（startNapuketto / NapukettoCore.create）。 */
export function isKernelModule(val: unknown): val is KernelLike {
    if (!isRecord(val)) {
        return false;
    }
    return hasCallableProp(val, "startNapuketto") || hasCallableProp(val, "NapukettoCore");
}

/** network 模块：EventBroadcaster 构造器（协议隔离事件总线）。 */
export function isNetworkModule(val: unknown): val is NetworkModuleLike {
    return hasCallableProp(val, "EventBroadcaster");
}

/**
 * 通用协议模块面守卫：适配器构造器可调用 + `<schemaKey>.parse` 可调用 +
 * （可选）`<defaultsKey>` 可调用。四协议结构同构，收敛为一处实现。
 */
function hasProtocolSurface(
    val: unknown,
    ctorKey: string,
    schemaKey: string,
    defaultsKey?: string,
): boolean {
    if (!isRecord(val) || !hasCallableProp(val, ctorKey)) {
        return false;
    }
    const schema = val[schemaKey];
    if (!isRecord(schema) || !hasCallableProp(schema, "parse")) {
        return false;
    }
    return defaultsKey === undefined || hasCallableProp(val, defaultsKey);
}

/** adapter onebot11 子路径：适配器构造器 + 配置 schema。 */
export function isOb11Module(val: unknown): val is Ob11ModuleLike {
    return hasProtocolSurface(val, "NapukettoOneBot11Adapter", "ob11ConfigSchema");
}

/** adapter satori 子路径：适配器构造器 + 配置 schema。 */
export function isSatoriModule(val: unknown): val is SatoriModuleLike {
    return hasProtocolSurface(val, "NapukettoSatoriAdapter", "satoriConfigSchema");
}

/** adapter kurobot 子路径：适配器构造器 + 配置 schema/defaults。 */
export function isKurobotModule(val: unknown): val is KurobotModuleLike {
    return hasProtocolSurface(
        val,
        "NapukettoKurobotAdapter",
        "kurobotConfigSchema",
        "kurobotConfigDefaults",
    );
}

/** adapter milky 子路径：适配器构造器 + 配置 schema。 */
export function isMilkyModule(val: unknown): val is MilkyModuleLike {
    return hasProtocolSurface(val, "NapukettoMilkyAdapter", "milkyConfigSchema");
}

/** adapter core 子路径：ProtocolConfig 配置框架。 */
export function isAdapterCoreModule(val: unknown): val is AdapterCoreModuleLike {
    return hasMethodSurface(val, ["ProtocolConfig"]);
}
