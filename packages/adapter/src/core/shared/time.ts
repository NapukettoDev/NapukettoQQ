/**
 * NT 时间戳归一（2026-11-10，Linux 原生宿主实测）。
 *
 * `RawMessage.msgTime` 的单位随平台 / wrapper 版本不一致：
 *  - Windows QQNT：**毫秒**字符串（13 位，如 `1700000000000`）；
 *  - Linux 3.2.x 原生 wrapper：**秒**字符串（10 位，如 `1794307394`）。
 *
 * 协议层统一按 Unix 秒输出。若不归一，Linux 上事件时间会被再除一次 1000，
 * 退化成 1970 年（实测 `1794307394` → `1794307`）。
 */

/** 毫秒阈值：1e12 秒 ≈ 公元 33658 年，真实毫秒时间戳必然大于它。 */
const MS_THRESHOLD = 1e12;

/**
 * msgTime → Unix 秒（按量级自动识别秒 / 毫秒）。
 * 非法 / 空 / 非正 → 0（调用方自行决定兜底策略）。
 */
export function toUnixSeconds(raw: string | number | undefined): number {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
        return 0;
    }
    return n >= MS_THRESHOLD ? Math.floor(n / 1000) : Math.floor(n);
}
