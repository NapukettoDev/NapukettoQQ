/**
 * json-safe.ts：IPC 出站负载 JSON 安全化（2026-10-24）。
 *
 * `JSON.stringify` 对 Map/Set 内容全丢（Map → `{}`、Set → `[]`）：
 * kernel 事件 args（RawMessage.videoElement.thumbPath `Map<0, path>`）与
 * 动作结果（如 GroupApi.uinToUid 的 `Map<qq, uid>`）跨进程后全部退化为
 * 空对象——koishi 插件侧读 `thumbPath.get(0)` 直接 TypeError，整条视频
 * 消息事件分派失败（2026-10-24 线上报）。编码前深规整：
 *  - Map → 平面对象（Object.fromEntries，数字 key 变字符串 key）
 *  - Set → 数组
 *  - 普通对象/数组递归；非普通对象（Date/Buffer/类实例）原样交 stringify
 *    （与既有行为一致，不引入新语义）
 * 幂等：已规整的负载再跑一遍结果不变。
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
