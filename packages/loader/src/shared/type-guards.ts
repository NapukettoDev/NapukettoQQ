/**
 * loader 本地运行时类型守卫。shared/ 是最底层，编译期只依赖 zod，因此不能复用 `@napuketto/kernel` 的守卫实现。
 * 动态 import 结果、IPC 参数、原生反射对象一律经此收窄；`getErrorMessage` 是唯一错误信息提取口径。
 */

/** 判断未知值是否为非 null、非数组的普通对象 Record。 */
export function isRecord(val: unknown): val is Record<string, unknown> {
    return typeof val === "object" && val !== null && !Array.isArray(val);
}

export function isCallable(val: unknown): val is (...args: unknown[]) => unknown {
    return typeof val === "function";
}

/** 安全读取任意值上的属性（含原型链 / 函数对象）。 */
export function getOwnProp(val: unknown, key: string): unknown {
    if ((typeof val !== "object" && typeof val !== "function") || val === null) {
        return undefined;
    }
    return Reflect.get(val, key);
}

/** 判断对象 / 构造器是否具备指定名称的可调用方法。 */
export function hasCallableProp<K extends string>(
    val: unknown,
    key: K,
): val is Record<K, (...args: unknown[]) => unknown> & Record<string, unknown> {
    if ((typeof val !== "object" && typeof val !== "function") || val === null) {
        return false;
    }
    return typeof Reflect.get(val, key) === "function";
}

/** 判断对象 / 构造器是否同时具备一组方法面。 */
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

/** 从未知异常中安全提取系统错误码（ENOENT / ESRCH / EPERM 等）。 */
export function getErrorCode(err: unknown): string | undefined {
    if (!isRecord(err)) {
        return undefined;
    }
    return typeof err["code"] === "string" ? err["code"] : undefined;
}

/** 从未知异常中安全提取消息文本。 */
export function getErrorMessage(err: unknown): string {
    if (err instanceof Error) {
        return err.message;
    }
    if (isRecord(err) && typeof err["message"] === "string") {
        return err["message"];
    }
    return String(err);
}

/** 安全解析 JSON 文本并交由类型守卫验证；解析失败或校验失败均返回 null。 */
export function parseJsonWithGuard<T>(raw: string, guard: (val: unknown) => val is T): T | null {
    try {
        const parsed: unknown = JSON.parse(raw);
        return guard(parsed) ? parsed : null;
    } catch {
        return null;
    }
}
