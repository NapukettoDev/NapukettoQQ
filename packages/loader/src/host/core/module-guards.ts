/**
 * module-guards.ts：动态 `import()` 模块的运行时结构校验器。
 *
 * 背景（Step 3）：bootstrap / assemble-protocols / ipc-ob11 通过 file:// 动态
 * import kernel / adapter / network，返回类型是 `unknown`。此前用
 * `as unknown as *ModuleLike` 暴力收窄——模块缺导出时运行期才炸。这里以方法面
 * 守卫收窄，失败走显式错误（不静默）。
 */

import { hasCallableProp, hasMethodSurface, isRecord } from "../type-guards.js";
import type {
    AdapterCoreModuleLike,
    KernelLike,
    KurobotModuleLike,
    MilkyModuleLike,
    NetworkModuleLike,
    Ob11ModuleLike,
    SatoriModuleLike,
} from "../types.js";

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

/** adapter onebot11 子路径：适配器构造器 + 配置 schema。 */
export function isOb11Module(val: unknown): val is Ob11ModuleLike {
    if (!isRecord(val) || !hasCallableProp(val, "NapukettoOneBot11Adapter")) {
        return false;
    }
    const schema = val["ob11ConfigSchema"];
    return isRecord(schema) && hasCallableProp(schema, "parse");
}

/** adapter satori 子路径：适配器构造器 + 配置 schema。 */
export function isSatoriModule(val: unknown): val is SatoriModuleLike {
    if (!hasCallableProp(val, "NapukettoSatoriAdapter")) {
        return false;
    }
    const schema = val["satoriConfigSchema"];
    return isRecord(schema) && hasCallableProp(schema, "parse");
}

/** adapter kurobot 子路径：适配器构造器 + 配置 schema/defaults。 */
export function isKurobotModule(val: unknown): val is KurobotModuleLike {
    if (!hasCallableProp(val, "NapukettoKurobotAdapter")) {
        return false;
    }
    const schema = val["kurobotConfigSchema"];
    return (
        isRecord(schema) &&
        hasCallableProp(schema, "parse") &&
        hasCallableProp(val, "kurobotConfigDefaults")
    );
}

/** adapter milky 子路径：适配器构造器 + 配置 schema。 */
export function isMilkyModule(val: unknown): val is MilkyModuleLike {
    if (!hasCallableProp(val, "NapukettoMilkyAdapter")) {
        return false;
    }
    const schema = val["milkyConfigSchema"];
    return isRecord(schema) && hasCallableProp(schema, "parse");
}

/** adapter core 子路径：ProtocolConfig 配置框架。 */
export function isAdapterCoreModule(val: unknown): val is AdapterCoreModuleLike {
    return hasMethodSurface(val, ["ProtocolConfig"]);
}
