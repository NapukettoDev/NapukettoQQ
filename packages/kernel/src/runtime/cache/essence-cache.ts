import type { EssenceMsgItem, GroupApi } from "../../apis/index.js";
import { isRecord } from "../../infra/type-guards.js";
import type { GroupEventChannel } from "../../native/bridge/index.js";
import { GroupMembership } from "./group-membership.js";

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
    onAdded: (
        groupCode: string,
        added: readonly EssenceAddedItem[],
        signal?: AbortSignal,
    ) => void | Promise<void>;
    /** diff 移除项广播（prev 供 sender 回填）。 */
    onRemoved: (
        groupCode: string,
        removed: readonly number[],
        prev: ReadonlyMap<number, EssenceCacheEntry>,
        signal?: AbortSignal,
    ) => void | Promise<void>;
    /** 列表拉取失败时保留旧基线。 */
    onFetchError?: (groupCode: string, err: unknown) => void;
    /** 通知失败时继续处理后续任务。 */
    onNotifyError?: (groupCode: string, err: unknown) => void;
    /** 队列无法容纳新任务时由后续事件补拉。 */
    onQueueFull?: (groupCode: string) => void;
    /** 重新订阅前已掌握的群成员资格。 */
    allowsGroup?: (groupCode: string) => boolean;
    /** 成员资格变化时清理协议实例持有的其他状态。 */
    onMembershipChange?: (allows: (groupCode: string) => boolean) => void;
}

const MAX_WAITING_GROUPS = 64;

interface EssenceJob {
    groupCode: string;
    controller: AbortController;
}

/** 每个协议装配实例串行拉取并对比精华列表。 */
export class EssenceListSync {
    private readonly deps: EssenceListSyncDeps;
    private readonly membership = new GroupMembership();
    private readonly caches = new Map<string, Map<number, EssenceCacheEntry>>();
    private readonly waiting = new Map<string, EssenceJob>();
    private running: EssenceJob | undefined;
    private scheduled = false;
    private active = true;
    private subscription: AbortController | undefined;
    private unsubscribe: Array<() => void> = [];

    constructor(deps: EssenceListSyncDeps) {
        this.deps = deps;
    }

    start(channel?: GroupEventChannel, groupApi?: Pick<GroupApi, "onGroupQuit">): void {
        if (this.subscription !== undefined) {
            return;
        }
        this.active = true;
        this.subscription = new AbortController();
        const { signal } = this.subscription;
        if (channel !== undefined) {
            this.unsubscribe.push(
                channel.on("Group/onGroupListInited", (listEmpty) => {
                    if (!signal.aborted && listEmpty) {
                        this.membership.replace([]);
                        this.prune();
                    }
                }),
                channel.on("Group/onGroupListUpdate", (type, groups) => {
                    if (!signal.aborted) {
                        this.membership.update(type, groups);
                        this.prune();
                    }
                }),
            );
        }
        const offQuit = groupApi?.onGroupQuit?.((groupCode) => {
            if (!signal.aborted) {
                this.membership.leave(groupCode);
                this.prune();
            }
        });
        if (offQuit !== undefined) {
            this.unsubscribe.push(offQuit);
        }
    }

    stop(): void {
        this.active = false;
        this.subscription?.abort();
        this.subscription = undefined;
        for (const off of this.unsubscribe.splice(0)) {
            off();
        }
        this.running?.controller.abort();
        this.waiting.clear();
        this.caches.clear();
        this.membership.clear();
        this.deps.onMembershipChange?.(() => false);
    }

    accepts(groupCode: string): boolean {
        return (
            this.active &&
            this.membership.allows(groupCode) &&
            this.deps.allowsGroup?.(groupCode) !== false
        );
    }

    private prune(): void {
        for (const groupCode of this.caches.keys()) {
            if (!this.membership.allows(groupCode)) {
                this.caches.delete(groupCode);
            }
        }
        for (const groupCode of this.waiting.keys()) {
            if (!this.membership.allows(groupCode)) {
                this.waiting.delete(groupCode);
            }
        }
        if (this.running !== undefined && !this.membership.allows(this.running.groupCode)) {
            this.running.controller.abort();
        }
        this.deps.onMembershipChange?.((groupCode) => this.membership.allows(groupCode));
    }

    enqueue(groupCode: string): void {
        if (!this.accepts(groupCode) || this.waiting.has(groupCode)) {
            return;
        }
        if (this.waiting.size >= MAX_WAITING_GROUPS) {
            this.deps.onQueueFull?.(groupCode);
            return;
        }
        this.waiting.set(groupCode, { groupCode, controller: new AbortController() });
        this.schedule();
    }

    private schedule(): void {
        if (this.running !== undefined || this.scheduled || this.waiting.size === 0) {
            return;
        }
        this.scheduled = true;
        queueMicrotask(() => {
            this.scheduled = false;
            const job = this.waiting.values().next().value;
            if (job === undefined) {
                return;
            }
            this.waiting.delete(job.groupCode);
            this.running = job;
            void this.sync(job)
                .catch((err: unknown) => {
                    this.deps.onNotifyError?.(job.groupCode, err);
                })
                .finally(() => {
                    this.running = undefined;
                    this.schedule();
                });
        });
    }

    private async sync({ groupCode, controller: { signal } }: EssenceJob): Promise<void> {
        if (!this.accepts(groupCode)) {
            return;
        }
        let items: EssenceMsgItem[];
        try {
            items = await this.deps.fetchList(groupCode);
        } catch (err) {
            if (!signal.aborted) {
                this.deps.onFetchError?.(groupCode, err);
            }
            return;
        }
        if (signal.aborted || !this.accepts(groupCode)) {
            return;
        }
        const prev = this.caches.get(groupCode);
        const { cache, added, removed } = diffEssenceList(prev, items);
        this.caches.set(groupCode, cache);
        if (prev === undefined) {
            return;
        }
        await this.deps.onAdded(groupCode, added, signal);
        if (!signal.aborted) {
            await this.deps.onRemoved(groupCode, removed, prev, signal);
        }
    }
}
