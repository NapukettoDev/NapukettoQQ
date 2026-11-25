/**
 * json-safe.ts：IPC 出站负载 JSON 安全化——`JSON.stringify` 会丢掉 Map/Set 内容（Map → `{}`、Set → `[]`）。
 * kernel 事件 args（`Map<0, path>`）与动作结果（`Map<qq, uid>`）跨进程会退化成空对象，koishi 侧 `.get(0)` 直接 TypeError。
 * 编码前深规整：Map → 平面对象（数字 key 变字符串）、Set → 数组、普通对象/数组递归，Date/Buffer/类实例原样交 stringify；幂等。
 */
export function toJsonSafe(value: unknown, ancestors: readonly object[] = []): unknown {
    if (value === null || typeof value !== "object") {
        return value;
    }
    if (ancestors.includes(value)) {
        // 环引用：丢弃该分支（stringify 遇环会整条消息抛错，丢分支严格更优）
        return undefined;
    }
    const nested = [...ancestors, value];
    if (value instanceof Map) {
        return toJsonSafe(Object.fromEntries(value), nested);
    }
    if (value instanceof Set) {
        return Array.from(value, (item) => toJsonSafe(item, nested));
    }
    if (Array.isArray(value)) {
        return value.map((item) => toJsonSafe(item, nested));
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
        return value;
    }
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
        const safe = toJsonSafe(val, nested);
        if (safe !== undefined) {
            out[key] = safe;
        }
    }
    return out;
}
