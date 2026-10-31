/**
 * 运行时反射探测基础工具（从 probe.ts 拆分，2026-08-08 FTA 优化）
 *
 * - listMethods：反射枚举对象原型链上的方法名（去重、去构造器）
 * - tryCall：安全调用方法拿返回值（失败记录错误，不中断探测）
 */

/** 反射枚举一个对象原型链上的方法名（去重、去构造器）。 */
export function listMethods(obj: unknown): string[] {
    if (obj === null || obj === undefined) {
        return [];
    }
    const names = new Set<string>();
    collectPrototypeNames(obj, names);
    collectOwnNames(obj, names);
    return [...names].sort();
}

/** 收集原型链上的属性名（到 Object/Function.prototype 为止，去构造器）。 */
function collectPrototypeNames(obj: unknown, names: Set<string>): void {
    let proto = Object.getPrototypeOf(obj);
    while (isProbeProto(proto)) {
        for (const name of Object.getOwnPropertyNames(proto)) {
            if (name !== "constructor") {
                names.add(name);
            }
        }
        proto = Object.getPrototypeOf(proto);
    }
}

/** 是否仍需遍历的原型（非 Object/Function.prototype 且非空）。 */
function isProbeProto(proto: object | null): proto is object {
    return proto !== null && proto !== Object.prototype && proto !== Function.prototype;
}

/** 收集自有属性名（去构造器）。 */
function collectOwnNames(obj: unknown, names: Set<string>): void {
    for (const name of Object.getOwnPropertyNames(obj)) {
        if (name !== "constructor") {
            names.add(name);
        }
    }
}

/** 安全调用：尝试调用方法拿返回值，失败记录错误（不中断探测）。 */
export function tryCall(
    obj: unknown,
    name: string,
): { ok: boolean; value?: unknown; error?: string } {
    try {
        const fn = (obj as Record<string, unknown>)[name];
        if (typeof fn !== "function") {
            return { ok: false, error: `not a function (typeof=${typeof fn})` };
        }
        const value = fn.call(obj);
        return { ok: true, value };
    } catch (e) {
        let message = String(e);
        if (e instanceof Error) {
            message = e.message;
        }
        return { ok: false, error: message };
    }
}

/** 服务 getter 判定（get*Service 命名约定）。 */
export function isServiceGetter(name: string): boolean {
    return name.startsWith("get") && name.endsWith("Service");
}
