/**
 * raw 日志截断与最小 logger 面（协议 adapter 校准日志共用，2026-11-14 自
 * onebot11/milky adapter.ts 顶部内联工具收拢）。
 *
 * info/warn 级 raw 字段对运行状态无信息量（2026-10-25 输出内容治理）：
 * hex/base64/JSON 原文保留前缀定位 + 缺省长度标注；完整值仅在 debug 级
 * 与日志文件中出现。两种截断口径刻意并存——OB11 校准日志带缺省长度标注，
 * Milky 长文本校准日志用固定切片（无标注）。
 */

/** info/warn 级截断缺省上限（OB11 口径）。 */
const RAW_INFO_LIMIT = 64;

/** 长文本截断缺省上限（debug / raw 校准日志防刷屏）。 */
const RAW_DEBUG_LIMIT = 2000;

/**
 * raw 字段截断：超限截断 + 缺省长度标注（…(+N)）。
 * OB11 校准日志（warn 级 64 缺省）口径。
 */
export function truncRaw(value: string | undefined, keep = RAW_INFO_LIMIT): string {
    if (value === undefined) {
        return "";
    }
    return value.length <= keep ? value : `${value.slice(0, keep)}…(+${value.length - keep})`;
}

/** 长文本截断：固定上限切片（Milky 校准日志 2000 缺省口径，无长度标注）。 */
export function sliceRaw(value: string | undefined, max = RAW_DEBUG_LIMIT): string {
    return value === undefined ? "" : value.slice(0, max);
}

/** 最小 logger 面（校准日志用：未知事件形状打 raw JSON；缺省静默）。 */
export interface AdapterLoggerLike {
    warn(obj: unknown, msg?: string): void;
    info(obj: unknown, msg?: string): void;
    /** 校准数据（2026-10-25 级别重分配：info → debug；此面必须支持）。 */
    debug(obj: unknown, msg?: string): void;
}
