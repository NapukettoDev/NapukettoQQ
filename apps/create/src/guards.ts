/**
 * 脚手架本地类型守卫（零依赖）。
 *
 * apps/create 只依赖 @clack/prompts（编译期不依赖 kernel），因此不能复用
 * `@napuketto/kernel` 的守卫；这里提供最小 `isRecord`，用于 JSON.parse 结果的
 * 运行时收窄，禁止 `as` 断言。
 */

/** 判断未知值是否为非 null、非数组的普通对象 Record。 */
export function isRecord(val: unknown): val is Record<string, unknown> {
    return typeof val === "object" && val !== null && !Array.isArray(val);
}
