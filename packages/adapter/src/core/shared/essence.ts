/**
 * 群精华共享翻译层（2026-11-03 自 milky/helper/essence.ts 上移，milky + onebot11 共用）
 *
 * 数据源（milky.md §0.8.6 识别表，三轮录制实证）：
 *  - sysmsg 732:1 群精华设置：f1.f1=群号, f1.f8.f8.f1=msgSeq（extractEssenceSetSysMsg）；
 *    取消精华无独立 sysmsg。push 内无 sender/operator——milky 作即时快路径，
 *    onebot11 作加速触发器（事件字段要求完整，走列表 diff 补齐）。
 *  - Group/onGroupEssenceListChange（录制实证 payload 只有群号）→
 *    WebApi.getEssenceMsgList 全量列表 diff：新增/移除 + operator（add_digest_uin）
 *    + sender（sender_uin）回填，是双方共用的发射路径。
 */
import type { EssenceMsgItem } from "@napuketto/kernel";
import { type SysMsgField, varintAt } from "./sysmsg.js";

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

/** 列表缓存条目：seq → 操作者/发送者 uin（null = 不可得）。 */
export interface EssenceCacheEntry {
    /** 加精操作者（add_digest_uin；取消场景无值）。 */
    operatorUin: string | null;
    /** 被加精消息发送者（sender_uin；OB11 delete 事件 sender_id 只能从缓存回填）。 */
    senderUin: string | null;
    /** 加精时间（add_digest_time 秒级 unix；非正数 → null = 不可得）。 */
    addDigestTime: number | null;
}

/** 列表 diff 结果：cache = 新列表缓存。 */
export interface EssenceDiffResult {
    cache: Map<number, EssenceCacheEntry>;
    /** 新增（is_set=true）；operator = add_digest_uin，sender = sender_uin。 */
    added: EssenceAddedItem[];
    /** 移除（is_set=false；移除者不可从列表得知，operator 省略）。 */
    removed: number[];
}

/** diff 新增条目。 */
export interface EssenceAddedItem {
    messageSeq: number;
    operatorUin: string | null;
    senderUin: string | null;
    addDigestTime: number | null;
}

/** 列表项 uin 提取（缺失/空 → null）。 */
function itemUin(value: unknown): string | null {
    return typeof value === "string" && value !== "" ? value : null;
}

/** 列表项 → 缓存条目。 */
function essenceEntry(item: EssenceMsgItem): EssenceCacheEntry {
    const time = item.add_digest_time;
    return {
        operatorUin: itemUin(item.add_digest_uin),
        senderUin: itemUin(item.sender_uin),
        addDigestTime: typeof time === "number" && time > 0 ? time : null,
    };
}

/** 列表 → 缓存 map（seq → 条目）。 */
function buildEssenceCache(items: readonly EssenceMsgItem[]): Map<number, EssenceCacheEntry> {
    const cache = new Map<number, EssenceCacheEntry>();
    for (const item of items) {
        if (typeof item.msg_seq === "number") {
            cache.set(item.msg_seq, essenceEntry(item));
        }
    }
    return cache;
}

/** 新增项收集（cache 新键即新增）。 */
function collectAdded(
    prev: ReadonlyMap<number, EssenceCacheEntry>,
    cache: ReadonlyMap<number, EssenceCacheEntry>,
): EssenceAddedItem[] {
    const added: EssenceAddedItem[] = [];
    for (const [seq, entry] of cache) {
        if (!prev.has(seq)) {
            added.push({
                messageSeq: seq,
                operatorUin: entry.operatorUin,
                senderUin: entry.senderUin,
                addDigestTime: entry.addDigestTime,
            });
        }
    }
    return added;
}

/** 移除项收集（cache 无即移除；移除者不可知）。 */
function collectRemoved(
    prev: ReadonlyMap<number, EssenceCacheEntry>,
    cache: ReadonlyMap<number, EssenceCacheEntry>,
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
    prev: ReadonlyMap<number, EssenceCacheEntry> | undefined,
    items: readonly EssenceMsgItem[],
): EssenceDiffResult {
    const cache = buildEssenceCache(items);
    if (prev === undefined) {
        return { cache, added: [], removed: [] };
    }
    return { cache, added: collectAdded(prev, cache), removed: collectRemoved(prev, cache) };
}

/** sysmsg 732:1 提取结果。 */
export interface EssenceSetSysMsg {
    groupCode: number;
    messageSeq: number;
}

/** sysmsg 732:1 → 群号 + msgSeq（识别表实证路径；任一缺失 → null）。 */
export function extractEssenceSetSysMsg(tree: readonly SysMsgField[]): EssenceSetSysMsg | null {
    const groupCode = varintAt(tree, [1, 1]);
    const messageSeq = varintAt(tree, [1, 8, 8, 1]);
    if (groupCode === null || messageSeq === null) {
        return null;
    }
    return { groupCode, messageSeq };
}
