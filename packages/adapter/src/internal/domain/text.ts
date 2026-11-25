/**
 * 字符串取值小工具（跨协议共用）
 *
 * NT 原生对象表达「没有值」的方式不统一：Windows 倾向省略字段，Linux 倾向给空串
 * （见 raw-message 的昵称口径）。凡「候选字段择一」的语义都走 `firstNonEmptyString`，
 * 避免 `??` 把空串当成有效值。
 */

/**
 * 取首个非空（非 `null` / `undefined` 且非 `""`）的字符串；全部缺省返回 `undefined`。
 * Linux 原生对象未命中的字段是显式 `null`（不只 `undefined`）。
 */
export function firstNonEmptyString(...values: (string | null | undefined)[]): string | undefined {
    for (const value of values) {
        if (value != null && value !== "") {
            return value;
        }
    }
    return undefined;
}

/** 未知值 → 字符串（非字符串返回 `undefined`；防御未校准的原生字段）。 */
export function stringOrUndefined(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}
