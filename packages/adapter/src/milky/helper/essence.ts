/**
 * group_essence_message_change 翻译（Milky 批次三）
 *
 * 双路径（milky.md §0.8.6）：
 *  - set 快路径：sysmsg 732:1（f1.f1=群号, f1.f8.f8.f1=msgSeq）即时广播，
 *    operator 不可得省略——识别表在 helper/sysmsg.ts；
 *  - remove + operator 回填：Group/onGroupEssenceListChange（录制实证 payload
 *    只有群号）→ getEssenceMsgList 全量列表 diff（EssenceMsgItem.add_digest_uin
 *    = 加精操作者）。取消精华无独立 sysmsg，只能 diff 发现。
 *
 * 两路共用适配器的 RecentKeyCache（键 群:seq:方向）——谁先到谁广播。
 */
import type { EssenceMsgItem } from "@napuketto/kernel";

/** 单个候选值 → 群号字符串（非空字符串 / 正整数）。 */
function toGroupCode(value: unknown): string | null {
    if (typeof value === "string" && value !== "") {
        return value;
    }
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
        return String(value);
    }
    return null;
}

/** onGroupEssenceListChange 参数 → 群号（录制实证首项字符串；防御收窄）。 */
export function narrowEssenceGroupArg(arg: unknown): string | null {
    const first = Array.isArray(arg) ? arg[0] : arg;
    if (first !== null && typeof first === "object") {
        const rec = first as Record<string, unknown>;
        for (const key of ["groupCode", "group_code", "groupId", "peerUid"] as const) {
            const code = toGroupCode(rec[key]);
            if (code !== null) {
                return code;
            }
        }
        return null;
    }
    return toGroupCode(first);
}

/** 列表 diff 结果：cache = 新列表缓存（seq → 操作者 uin，空串 = 未知）。 */
export interface EssenceDiffResult {
    cache: Map<number, string>;
    /** 新增（is_set=true）；operatorUin = add_digest_uin（null = 不可得）。 */
    added: Array<{ messageSeq: number; operatorUin: string | null }>;
    /** 移除（is_set=false；移除者不可从列表得知，operator 省略）。 */
    removed: number[];
}

/** 精华列表项 → 缓存操作者（add_digest_uin 缺失/空 → 空串 = 未知）。 */
function essenceOperator(item: EssenceMsgItem): string {
    return typeof item.add_digest_uin === "string" && item.add_digest_uin !== ""
        ? item.add_digest_uin
        : "";
}

/** 列表 → 缓存 map（seq → 操作者）。 */
function buildEssenceCache(items: readonly EssenceMsgItem[]): Map<number, string> {
    const cache = new Map<number, string>();
    for (const item of items) {
        if (typeof item.msg_seq === "number") {
            cache.set(item.msg_seq, essenceOperator(item));
        }
    }
    return cache;
}

/** 新增项收集（cache 新键即新增）。 */
function collectAdded(
    prev: ReadonlyMap<number, string>,
    cache: ReadonlyMap<number, string>,
): EssenceDiffResult["added"] {
    const added: EssenceDiffResult["added"] = [];
    for (const [seq, operator] of cache) {
        if (!prev.has(seq)) {
            added.push({ messageSeq: seq, operatorUin: operator === "" ? null : operator });
        }
    }
    return added;
}

/** 移除项收集（cache 无即移除；移除者不可知）。 */
function collectRemoved(
    prev: ReadonlyMap<number, string>,
    cache: ReadonlyMap<number, string>,
): number[] {
    const removed: number[] = [];
    for (const seq of prev.keys()) {
        if (!cache.has(seq)) {
            removed.push(seq);
        }
    }
    return removed;
}

/**
 * 精华列表 diff：prev 缺省（基线未建立）时只建缓存不产出事件——
 * 首个变更事件只做基线，避免全量首推被误报为「逐条加精」。
 */
export function diffEssenceList(
    prev: ReadonlyMap<number, string> | undefined,
    items: readonly EssenceMsgItem[],
): EssenceDiffResult {
    const cache = buildEssenceCache(items);
    if (prev === undefined) {
        return { cache, added: [], removed: [] };
    }
    return { cache, added: collectAdded(prev, cache), removed: collectRemoved(prev, cache) };
}
