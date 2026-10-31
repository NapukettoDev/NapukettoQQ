/**
 * 运行时反射探测的序列化工具（从 probe.ts 拆分，2026-08-08 FTA 优化）
 *
 * - serialize：深度受限序列化（BigInt 转字符串，Map/Set/Promise 展开，循环引用防护）
 * - tryShape：解析 service getter 返回形状
 */

/** 序列化深度上限（循环引用/深层对象防护）。 */
const MAX_SERIALIZE_DEPTH = 4;
/** 数组序列化条数上限。 */
const MAX_ARRAY_ITEMS = 20;
/** 对象键序列化条数上限。 */
const MAX_OBJECT_KEYS = 50;

/** 序列化一个值（BigInt 转字符串，Map/Set/Promise 展开，循环引用防护）。 */
export function serialize(value: unknown, depth = 0): unknown {
    if (value === null || value === undefined) return value;
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "function") return `[function ${value.name ?? "anon"}]`;
    if (typeof value !== "object") return value;
    if (depth > MAX_SERIALIZE_DEPTH) return "[depth-limit]";
    try {
        return serializeContainer(value, depth);
    } catch {
        return "[unserializable]";
    }
}

/** 序列化容器对象（数组 / Map / Set / Promise / 普通对象）。 */
function serializeContainer(value: object, depth: number): unknown {
    if (Array.isArray(value)) {
        return serializeArray(value, depth);
    }
    if (value instanceof Map) {
        return serializeMap(value, depth);
    }
    if (value instanceof Set) {
        return serializeSet(value, depth);
    }
    if (typeof (value as Promise<unknown>).then === "function") {
        return "[Promise]";
    }
    return serializeObject(value, depth);
}

/** 数组序列化（条数截断）。 */
function serializeArray(value: unknown[], depth: number): unknown[] {
    return value.slice(0, MAX_ARRAY_ITEMS).map((v) => serialize(v, depth + 1));
}

/** Map 序列化（键转字符串，条目截断）。 */
function serializeMap(value: Map<unknown, unknown>, depth: number): unknown {
    const out: Record<string, unknown> = {};
    let i = 0;
    for (const [k, v] of value) {
        if (i >= MAX_OBJECT_KEYS) break;
        out[String(k)] = serialize(v, depth + 1);
        i += 1;
    }
    return { kind: "Map", size: value.size, entries: out };
}

/** Set 序列化（值截断）。 */
function serializeSet(value: Set<unknown>, depth: number): unknown {
    return {
        kind: "Set",
        size: value.size,
        values: [...value].slice(0, MAX_ARRAY_ITEMS).map((v) => serialize(v, depth + 1)),
    };
}

/** 普通对象序列化（键截断）。 */
function serializeObject(value: object, depth: number): unknown {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).slice(0, MAX_OBJECT_KEYS)) {
        out[key] = serialize((value as Record<string, unknown>)[key], depth + 1);
    }
    return out;
}

/** 尝试解析一个 service getter 的返回值形状（深度受限）。 */
export function tryShape(session: unknown, getter: string): unknown {
    try {
        const fn = (session as Record<string, unknown>)[getter];
        if (typeof fn !== "function") return null;
        const value = fn.call(session);
        if (value === null || value === undefined) return null;
        return serialize(value);
    } catch {
        return "[error]";
    }
}
