/**
 * uid → uin 解析（OB11 / Milky 请求与通知翻译共用，P1 2026-10-30 收敛）
 *
 * uidToUin 批量映射由调用方取得后传入；映射缺省退化为 uid 数值（wrapper 部分回调
 * 直接给 uin），非数字返回 0（调用方按 0 兜底展示）。
 *
 * request 事件翻译上下文与毫秒换算常量随本模块共享（OB11 / Milky request 同构）。
 */

/** 毫秒 → 秒（Unix 时间戳换算）。 */
export const MS_TO_SEC = 1000;

/** request 事件翻译上下文（uid→uin 映射，调用方批量转换）。 */
export interface RequestTranslateContext {
    selfUin: string;
    uidToUin: Map<string, string>;
}

/** uid → uin（映射命中取 uin，未命中退化 uid 数值，非数字返回 0）。 */
export function resolveUin(uid: string | undefined, uidToUin: Map<string, string>): number {
    if (uid === undefined || uid === "") {
        return 0;
    }
    const uin = uidToUin.get(uid);
    if (uin !== undefined) {
        return Number(uin);
    }
    const n = Number(uid);
    return Number.isFinite(n) ? n : 0;
}
