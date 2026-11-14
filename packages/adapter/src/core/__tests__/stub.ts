/**
 * 测试专用强类型桩工厂（全包测试共用）。
 *
 * 目标：消灭测试里 `{...} as unknown as Xxx` 的暴力强转——改用本工厂后，
 * 覆盖字段在调用点按真实类型校验（拼错字段名/字段类型直接编译失败），唯一
 * 的宽松收窄收在本文件内部，不再散落各测试文件。存根常同时服务多个
 * `Pick<T, ...>` 视图，故允许出现目标类型之外的多余键。
 */

/**
 * 桩来源形状：T 的字段全部可选且允许显式 undefined（exactOptionalPropertyTypes
 * 下 `Partial<T>` 不含 `| undefined`），另放行多余键。
 */
type StubSource<T> = { [K in keyof T]?: T[K] | undefined } & Record<string, unknown>;

/** 对象桩：部分形状 → 完整类型 T（调用点字段强类型，内部一次收窄）。 */
export function stub<T>(source: StubSource<T>): T {
    return source as T;
}

/** 数组桩：元素部分形状 → T[]（stub 的数组版，锁元素字段类型）。 */
export function stubList<T>(sources: readonly StubSource<T>[]): T[] {
    return sources as T[];
}
