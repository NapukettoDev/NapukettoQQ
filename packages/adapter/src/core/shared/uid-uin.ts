/**
 * uid → uin 解析（OB11 / Milky 请求与通知翻译共用，P1 2026-10-30 收敛；
 * 2026-11-14 起 Satori 事件翻译的 string 口径也归此模块）
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
export function resolveUin(uid: string | undefined, uidToUin: ReadonlyMap<string, string>): number {
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

/**
 * uid → uin（number 口径；ctx 只要求携带 uidToUin 映射——OB11 / Milky 的
 * request + notice 翻译通用，2026-11-14 自各协议本地 toUin 收拢）。
 */
export function toUin(
    uid: string | undefined,
    ctx: { uidToUin: ReadonlyMap<string, string> },
): number {
    return resolveUin(uid, ctx.uidToUin);
}

/**
 * uid → uin（string 口径：Satori 资源对象 user.id 保留协议串；映射缺省退化
 * uid 原文，2026-11-14 自 satori/event/translate.ts 收拢）。
 */
export function toUinString(uid: string, uidToUin: ReadonlyMap<string, string>): string {
    return uidToUin.get(uid) ?? uid;
}

/** 数字串判别（uin）。 */
const NUMERIC_RE = /^\d+$/;

/**
 * 数字串 uin → number（缺失/非法 → null，调用方按口径省略或跳过；
 * 2026-11-14 自 onebot11 adapter.ts 收拢，essence 载荷 operator/sender 用）。
 */
export function numericUin(value: string | null): number | null {
    return value !== null && NUMERIC_RE.test(value) ? Number(value) : null;
}
