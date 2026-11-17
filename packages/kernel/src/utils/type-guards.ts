/**
 * 通用运行时类型守卫集（全仓复用，零依赖）
 *
 * 目标：把「外部边界进来的 unknown」经**可证明的**运行时检查收窄为业务类型，
 * 取代 `as unknown as T` / `as T` 一类绕过编译器的虚假类型安全。
 *
 * 约定：
 *  - 只做形状判定，不做业务语义校验（业务错误仍由调用方抛 KernelError）；
 *  - 守卫是 `val is T` 型谓词，收窄由编译器自然推导，调用方无需再断言；
 *  - 失败路径统一经 kernelError 抛 INVALID_STATE（ADR-009），不抛裸 Error。
 *
 */
import { kernelError } from "../infra/errors.js";

/** 判断未知值是否为非 null 且非数组的普通对象 Record。 */
export function isRecord(val: unknown): val is Record<string, unknown> {
    return typeof val === "object" && val !== null && !Array.isArray(val);
}

/** 判断对象是否包含指定字段且类型为 string。 */
export function hasStringProp<K extends string>(
    obj: Record<string, unknown>,
    key: K,
): obj is Record<string, unknown> & Record<K, string> {
    return typeof obj[key] === "string";
}

/** 判断对象是否包含指定字段且类型为有限 number。 */
export function hasNumberProp<K extends string>(
    obj: Record<string, unknown>,
    key: K,
): obj is Record<string, unknown> & Record<K, number> {
    return typeof obj[key] === "number" && Number.isFinite(obj[key]);
}

/** 判断对象是否包含指定字段且类型为 boolean。 */
export function hasBooleanProp<K extends string>(
    obj: Record<string, unknown>,
    key: K,
): obj is Record<string, unknown> & Record<K, boolean> {
    return typeof obj[key] === "boolean";
}

/** 判断对象是否包含指定字段且类型为 function。 */
export function hasFunctionProp<K extends string>(
    obj: Record<string, unknown>,
    key: K,
): obj is Record<string, unknown> & Record<K, (...args: never[]) => unknown> {
    return typeof obj[key] === "function";
}

/**
 * 校验并收窄 Kernel Session 返回的原生 Service 实例。
 *
 * 原生 `get*Service()` 在 session 未 init / 句柄失效时可能返回 null、undefined、
 * 已 `isNull()` 的空句柄或残缺对象——直接 `as unknown as NodeIKernel*Service`
 * 会让调用方在第一次方法调用时炸出裸 TypeError。这里统一在边界拦截：
 * 空 / 非对象 / isNull() === true / 缺失关键方法一律抛 INVALID_STATE。
 */
export function requireKernelService<T extends object>(
    raw: T | null | undefined,
    serviceName: string,
    requiredMethods: readonly (keyof T & string)[] = [],
): T {
    if (raw === null || raw === undefined || !isRecord(raw)) {
        throw kernelError(`${serviceName}() 返回空（session 未 init）`, "INVALID_STATE");
    }
    if (hasFunctionProp(raw, "isNull")) {
        const nullHandle: unknown = raw["isNull"]();
        if (nullHandle === true) {
            throw kernelError(`${serviceName}() 返回空句柄（isNull 为 true）`, "INVALID_STATE");
        }
    }
    for (const method of requiredMethods) {
        if (typeof raw[method] !== "function") {
            throw kernelError(`${serviceName}() 返回对象缺失必要方法: ${method}`, "INVALID_STATE");
        }
    }
    return raw;
}
