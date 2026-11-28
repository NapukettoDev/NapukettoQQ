/**
 * module-guards.ts：动态 `import()` 模块的运行时结构校验器。
 * bootstrap / assemble-ob11 / ob11-bridge 用 file:// 动态 import kernel / adapter / network，返回类型是
 * `unknown`；这里以方法面守卫收窄，缺导出时抛显式错误，而不是 `as unknown as *ModuleLike` 到运行期才炸。
 */

import { hasCallableProp, hasMethodSurface, isRecord } from "../../shared/type-guards.js";
import type {
    AdapterCoreModuleLike,
    KurobotModuleLike,
    MilkyModuleLike,
    NetworkModuleLike,
    Ob11ModuleLike,
    SatoriModuleLike,
} from "./protocol-types.js";
import type { KernelLike } from "./types.js";

/** 自建宿主的必需入口。 */
export function isKernelModule(val: unknown): val is KernelLike {
    return hasCallableProp(val, "prepareSelfHost");
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
