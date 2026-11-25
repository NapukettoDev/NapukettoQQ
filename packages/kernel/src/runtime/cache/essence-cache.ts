/**
 * EssenceListSync：群精华列表缓存 + 首帧基线抑制 + 串行 diff 同步（ADR-008 / ADR-028）
 *
 * - 缓存：群号 → seq → 条目（operator / sender / addDigestTime），随列表全量快照重建。
 * - 首帧：基线未建立时只建缓存、不产出事件——启动首推不能被误报为「逐条加精」。
 * - 串行：732:1 触发器与列表回调共用一条 promise 链；并发回写乱序会把新列表覆盖成
 *   旧列表，故同一时刻只有一个拉取在跑，diff 幂等 + 串行天然去重。
 * - 消费：协议层在回调里做事件翻译 + message_id 反查 / 快路径去重（翻译仍是纯函数）。
 *
 * 无全局单例（ADR-015 推论）——每协议实例一份，由装配层持有。
 */

import type { EssenceMsgItem } from "../../apis/index.js";
import { isRecord } from "../../infra/type-guards.js";

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
    if (isRecord(first)) {
        for (const key of ["groupCode", "group_code", "groupId", "peerUid"] as const) {
            const code = toGroupCode(first[key]);
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

/** 精华列表同步依赖（拉取 + 广播回调；事件翻译归协议层）。 */
export interface EssenceListSyncDeps {
    /** 全量精华列表拉取（WebApi.getEssenceMsgList）。 */
    fetchList: (groupCode: string) => Promise<EssenceMsgItem[]>;
    /** diff 新增项广播（协议层做事件翻译 + message_id 反查 / 快路径去重）。 */
    onAdded: (groupCode: string, added: readonly EssenceAddedItem[]) => void | Promise<void>;
    /** diff 移除项广播（prev 供 sender 回填）。 */
    onRemoved: (
        groupCode: string,
        removed: readonly number[],
        prev: ReadonlyMap<number, EssenceCacheEntry>,
    ) => void | Promise<void>;
    /** 列表拉取失败（串行链不中断，下个触发器继续；缺省静默）。 */
    onFetchError?: (groupCode: string, err: unknown) => void;
}

/**
 * 精华列表串行同步器（OB11 / Milky adapter 共用）：
 *  - 列表缓存（群号 → seq → 条目）+ 串行链——并发回写乱序会把新列表覆盖成旧列表，
 *    732:1 触发器与列表回调共用一条链，谁先到谁触发，diff 幂等 + 串行天然去重；
 *  - 基线未建立只建基线不产出事件（避免全量首推被误报为逐条加精）。
 */
export class EssenceListSync {
    private readonly deps: EssenceListSyncDeps;
    private readonly caches = new Map<string, Map<number, EssenceCacheEntry>>();
    private chain: Promise<void> = Promise.resolve();

    constructor(deps: EssenceListSyncDeps) {
        this.deps = deps;
    }

    /** 入队单群串行同步（拉取 → diff → 广播 → 更新缓存）。 */
    enqueue(groupCode: string): void {
        this.chain = this.chain.then(
            () => this.sync(groupCode),
            () => undefined,
        );
    }

    /** 单群同步：拉取失败走 onFetchError；基线未建立只建缓存。 */
    private async sync(groupCode: string): Promise<void> {
        let items: EssenceMsgItem[];
        try {
            items = await this.deps.fetchList(groupCode);
        } catch (err) {
            this.deps.onFetchError?.(groupCode, err);
            return;
        }
        const prev = this.caches.get(groupCode);
        const { cache, added, removed } = diffEssenceList(prev, items);
        this.caches.set(groupCode, cache);
        if (prev === undefined) {
            return;
        }
        await this.deps.onAdded(groupCode, added);
        await this.deps.onRemoved(groupCode, removed, prev);
    }
}
