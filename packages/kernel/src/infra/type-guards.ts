/**
 * 通用运行时类型守卫集（全仓复用，零依赖）：把外部边界进来的 unknown 经**可证明的**运行时检查
 * 收窄为业务类型，取代双重断言一类绕过编译器的虚假类型安全。只做形状判定（业务语义错误仍由
 * 调用方抛 KernelError）；守卫是 `val is T` 型谓词，失败路径统一抛 INVALID_STATE（ADR-009）。
 */
import { kernelError } from "./errors.js";

/** 判断未知值是否为非 null、非数组的普通对象 Record。 */
export function isRecord(val: unknown): val is Record<string, unknown> {
    return typeof val === "object" && val !== null && !Array.isArray(val);
}

/** 判断未知值是否为可调用的函数。 */
export function isCallable(val: unknown): val is (...args: unknown[]) => unknown {
    return typeof val === "function";
}

/**
 * 安全读取任意值上的属性（支持 plain object 及带有原型链的原生 C++ 包装实例 / 函数对象）。
 */
export function getOwnProp(val: unknown, key: string): unknown {
    if ((typeof val !== "object" && typeof val !== "function") || val === null) {
        return undefined;
    }
    return Reflect.get(val, key);
}

/** 判断未知值是否为包含指定 string 属性的对象。 */
export function hasStringProp<K extends string>(
    val: unknown,
    key: K,
): val is Record<K, string> & Record<string, unknown> {
    return isRecord(val) && typeof val[key] === "string";
}

/** 判断未知值是否为包含指定有限 number 属性的对象。 */
export function hasNumberProp<K extends string>(
    val: unknown,
    key: K,
): val is Record<K, number> & Record<string, unknown> {
    return isRecord(val) && typeof val[key] === "number" && Number.isFinite(val[key]);
}

/** 可选字段：缺失（undefined / null）放行，存在时必须是 string。 */
export function hasNullableStringProp(rec: Record<string, unknown>, key: string): boolean {
    const value = rec[key];
    return value === undefined || value === null || typeof value === "string";
}

/** 可选字段：缺失（undefined / null）放行，存在时必须是有限 number。 */
export function hasNullableNumberProp(rec: Record<string, unknown>, key: string): boolean {
    const value = rec[key];
    return (
        value === undefined ||
        value === null ||
        (typeof value === "number" && Number.isFinite(value))
    );
}

/** 可选字段：缺失（仅 undefined）放行，存在时必须是 string（null 不合法）。 */
export function hasOptionalStringProp(rec: Record<string, unknown>, key: string): boolean {
    const value = rec[key];
    return value === undefined || typeof value === "string";
}

/** 判断未知值是否为包含指定 boolean 属性的对象。 */
export function hasBooleanProp<K extends string>(
    val: unknown,
    key: K,
): val is Record<K, boolean> & Record<string, unknown> {
    return isRecord(val) && typeof val[key] === "boolean";
}

/**
 * 判断未知值（对象或原生构造器函数）是否具备指定名称的可调用方法。
 * 注意：参数类型收窄为 `...args: unknown[]`，支持直接传参或 `.call(target, ...)` 调用。
 */
export function hasFunctionProp<K extends string>(
    val: unknown,
    key: K,
): val is Record<K, (...args: unknown[]) => unknown> & Record<string, unknown> {
    if ((typeof val !== "object" && typeof val !== "function") || val === null) {
        return false;
    }
    return typeof Reflect.get(val, key) === "function";
}

/** `hasFunctionProp` 的语义别名，专用于反射与原生边界探测。 */
export const hasCallableProp = hasFunctionProp;

/**
 * 判断目标对象/实例是否同时具备一组方法面（Method Surface）。
 */
export function hasMethodSurface<const M extends readonly string[]>(
    val: unknown,
    methods: M,
): val is Record<M[number], (...args: unknown[]) => unknown> & Record<string, unknown> {
    if ((typeof val !== "object" && typeof val !== "function") || val === null) {
        return false;
    }
    for (const m of methods) {
        if (typeof Reflect.get(val, m) !== "function") {
            return false;
        }
    }
    return true;
}

/** 判断未知值是否为包含静态 `.get()` 工厂方法的原生导出项。 */
export function hasStaticGetter(val: unknown): val is { get: (...args: unknown[]) => unknown } {
    return hasFunctionProp(val, "get");
}

/** 判断未知值是否为包含静态 `.create()` 工厂方法的原生导出项。 */
export function hasStaticCreator(val: unknown): val is { create: (...args: unknown[]) => unknown } {
    return hasFunctionProp(val, "create");
}

/** 判断未知值是否为 Promise-like（具备 `.then` 与 `.catch` 方法）。 */
export function isPromiseLike(val: unknown): val is Promise<unknown> {
    return hasFunctionProp(val, "then") && hasFunctionProp(val, "catch");
}

/** 从未知异常中安全提取系统错误码（如 ENOENT / ESRCH / EPERM）。 */
export function getErrorCode(err: unknown): string | undefined {
    if (!isRecord(err)) return undefined;
    return typeof err["code"] === "string" ? err["code"] : undefined;
}

/** 从未知异常中安全提取错误消息文本。 */
export function getErrorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (isRecord(err) && typeof err["message"] === "string") return err["message"];
    return String(err);
}

/** 安全解析 JSON 文本并交由类型守卫验证，校验失败或解析抛错均返回 null。 */
export function parseJsonWithGuard<T>(raw: string, guard: (val: unknown) => val is T): T | null {
    try {
        const parsed: unknown = JSON.parse(raw);
        return guard(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * 校验原生 Kernel Service 实例是否非空且具备要求的核心方法集合。
 *
 * 原生 `get*Service()` 在 session 未 init / 句柄失效时可能返回 null、undefined、
 * 已 `isNull()` 的空句柄或残缺对象——直接断言成 NodeIKernel*Service
 * 会让调用方在第一次方法调用时炸出裸 TypeError。这里统一在边界拦截：
 * 空 / 非对象 / isNull() === true / 缺失关键方法一律抛 INVALID_STATE。
 */
export function requireKernelService<T extends object>(
    service: T | null | undefined,
    serviceName: string,
    requiredMethods: readonly (keyof T & string)[] = [],
): T {
    if (service === null || service === undefined || typeof service !== "object") {
        throw kernelError(`${serviceName}() 返回空（session 未 init）`, "INVALID_STATE");
    }
    if (hasFunctionProp(service, "isNull")) {
        const nullHandle: unknown = service["isNull"]();
        if (nullHandle === true) {
            throw kernelError(`${serviceName}() 返回空句柄（isNull 为 true）`, "INVALID_STATE");
        }
    }
    for (const method of requiredMethods) {
        if (typeof Reflect.get(service, method) !== "function") {
            throw kernelError(`${serviceName}() 返回对象缺失必要方法: ${method}`, "INVALID_STATE");
        }
    }
    return service;
}
