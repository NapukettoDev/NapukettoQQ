/**
 * BuddyCache：好友缓存（B2，2026-09-08；仿 GroupCache 的 ADR-008 模式）
 *
 * - 更新：订阅 Buddy/onBuddyListChange 全量快照（T10 实证 = BuddyCategory[]，
 *   好友明细在 category.buddyList）维护 uid → BuddyListEntry 快照。
 * - diff：首帧只建 baseline 不发事件（防止启动时对每个好友发 friend_add）；
 *   之后快照对比上一帧——新增发布 BuddyCache/onBuddyAdded、消失发布
 *   BuddyCache/onBuddyRemoved（归一化事件，协议层翻译保持纯函数）。
 * - 消费：协议翻译层订阅 diff 通道（friend_add notice）或只读快照查询。
 *
 * 无全局单例（ADR-015 推论）——每进程每 session 一份，由装配层持有。
 */

import { NTEventChannel } from "../../infra/event-channel.js";
import { isRecord } from "../../infra/type-guards.js";
import type { BuddyEventChannel } from "../../native/bridge/index.js";
import type { BuddyCategory, BuddyCoreInfo, BuddyListEntry } from "../../types/index.js";

/** BuddyCache diff 事件 listener（归一化「新增/删除」事件）。 */
export type BuddyCacheListener = {
    onBuddyAdded: (entry: BuddyListEntry) => void;
    onBuddyRemoved: (entry: BuddyListEntry) => void;
};

/** BuddyCache diff 事件通道（事件名 BuddyCache/onBuddyAdded 等）。 */
export type BuddyCacheEventChannel = NTEventChannel<BuddyCacheListener, "BuddyCache">;

/** BuddyCache 构造参数。 */
export interface BuddyCacheOptions {
    /** Buddy 事件通道（FriendBridge 注册原生监听后 emit 到这里）。 */
    channel: BuddyEventChannel;
    /** 校准日志（可选：快照形状异常 raw 记录；缺省静默）。 */
    logger?: { warn(obj: unknown, msg?: string): void };
}

/** 可选展示字段：存在且类型正确才拷贝（未知值丢弃）。 */
const MEMBER_STRING_KEYS = ["nick", "remark", "longNick", "avatarUrl", "topTime"] as const;
const MEMBER_NUMBER_KEYS = [
    "categoryId",
    "birthday_year",
    "birthday_month",
    "birthday_day",
    "sex",
] as const;

/** 拷贝成员可选字段（类型正确才写入）。 */
function copyMemberExtras(entry: BuddyListEntry, raw: Record<string, unknown>): void {
    for (const key of MEMBER_STRING_KEYS) {
        const value = raw[key];
        if (typeof value === "string") {
            entry[key] = value;
        }
    }
    for (const key of MEMBER_NUMBER_KEYS) {
        const value = raw[key];
        if (typeof value === "number") {
            entry[key] = value;
        }
    }
    const isBlocked = raw["isBlocked"];
    if (typeof isBlocked === "boolean") {
        entry["isBlocked"] = isBlocked;
    }
}

/** coreInfo 安全构造（uid/uin 必备）。 */
function parseCoreInfo(raw: unknown): BuddyCoreInfo | null {
    if (!isRecord(raw) || typeof raw["uid"] !== "string" || typeof raw["uin"] !== "string") {
        return null;
    }
    const out = { uid: raw["uid"], uin: raw["uin"] };
    const nick = raw["nick"];
    const remark = raw["remark"];
    return {
        ...out,
        ...(typeof nick === "string" ? { nick } : {}),
        ...(typeof remark === "string" ? { remark } : {}),
    };
}

/**
 * 解析单个好友明细（T10 实测形状：uid/uin 齐备；其余展示字段按类型安全拷贝）。
 * 返回真实构造的新对象——不把原生载荷直接断言成 `BuddyListEntry`。
 */
export function parseBuddyMember(raw: unknown): BuddyListEntry | null {
    if (!isRecord(raw) || typeof raw["uid"] !== "string" || typeof raw["uin"] !== "string") {
        return null;
    }
    const entry: BuddyListEntry = { uid: raw["uid"], uin: raw["uin"] };
    copyMemberExtras(entry, raw);
    const coreInfo = parseCoreInfo(raw["coreInfo"]);
    if (coreInfo !== null) {
        entry.coreInfo = coreInfo;
    }
    if (isRecord(raw["baseInfo"])) {
        entry.baseInfo = raw["baseInfo"];
    }
    return entry;
}

/** 单个分类项 → BuddyCategory（非对象返回 null）。 */
function parseBuddyCategory(item: unknown): BuddyCategory | null {
    if (!isRecord(item)) {
        return null;
    }
    const buddyListRaw = Array.isArray(item["buddyList"]) ? item["buddyList"] : [];
    const buddyList: BuddyListEntry[] = [];
    for (const b of buddyListRaw) {
        const parsed = parseBuddyMember(b);
        if (parsed !== null) {
            buddyList.push(parsed);
        }
    }
    return {
        categoryId: typeof item["categoryId"] === "number" ? item["categoryId"] : 0,
        categorySortId: typeof item["categorySortId"] === "number" ? item["categorySortId"] : 0,
        categroyName: typeof item["categroyName"] === "string" ? item["categroyName"] : "",
        categroyMbCount:
            typeof item["categroyMbCount"] === "number"
                ? item["categroyMbCount"]
                : buddyList.length,
        onlineCount: typeof item["onlineCount"] === "number" ? item["onlineCount"] : 0,
        buddyList,
    };
}

/**
 * 防御性收窄 onBuddyListChange 载荷 → BuddyCategory[]（T10 实证形状；
 * 非数组 / 非对象分类项返回 null，调用方打 raw 日志积累校准数据）。
 * 分类字段逐项做运行时类型校验并安全构造，缺失项取保守默认值。
 */
export function narrowBuddyCategories(arg: unknown): BuddyCategory[] | null {
    if (!Array.isArray(arg)) {
        return null;
    }
    const categories: BuddyCategory[] = [];
    for (const item of arg) {
        const category = parseBuddyCategory(item);
        if (category === null) {
            return null;
        }
        categories.push(category);
    }
    return categories;
}

/** 从快照分类拍平好友明细（buddyList 缺失的分类跳过）。 */
function flattenEntries(categories: BuddyCategory[]): BuddyListEntry[] {
    const out: BuddyListEntry[] = [];
    for (const cat of categories) {
        for (const entry of cat.buddyList ?? []) {
            if (typeof entry?.uid === "string" && entry.uid !== "") {
                out.push(entry);
            }
        }
    }
    return out;
}

/** 好友缓存：快照维护 + diff 归一化事件。 */
export class BuddyCache {
    private readonly channel: BuddyEventChannel;
    private readonly logger: { warn(obj: unknown, msg?: string): void } | undefined;

    /** diff 归一化事件通道（协议层订阅 friend_add / IPC 转发消费）。 */
    readonly events: BuddyCacheEventChannel = new NTEventChannel("BuddyCache");

    /** 好友快照（uid → entry，onBuddyListChange 全量维护）。 */
    private readonly buddies = new Map<string, BuddyListEntry>();

    /** 首帧已建 baseline（此后快照才参与 diff）。 */
    private bootstrapped = false;

    private unsubscribes: (() => void) | null = null;

    constructor(opts: BuddyCacheOptions) {
        this.channel = opts.channel;
        this.logger = opts.logger;
    }

    /** 订阅 Buddy 事件通道（幂等）。 */
    register(): void {
        if (this.unsubscribes !== null) {
            return;
        }
        const unsub = this.channel.on("Buddy/onBuddyListChange", (arg: unknown) => {
            const categories = narrowBuddyCategories(arg);
            if (categories === null) {
                // 未知形状：raw 日志积累校准数据（V2 事件载荷是 boolean，同样落这里）
                this.logger?.warn(
                    { raw: JSON.stringify(arg)?.slice(0, 2000) },
                    "BuddyCache: onBuddyListChange 未知载荷形状",
                );
                return;
            }
            this.applySnapshot(flattenEntries(categories));
        });
        this.unsubscribes = unsub;
    }

    /** 退订事件通道（幂等）。 */
    unregister(): void {
        this.unsubscribes?.();
        this.unsubscribes = null;
        this.buddies.clear();
        this.bootstrapped = false;
    }

    /** 释放（等价 unregister，幂等）。 */
    dispose(): void {
        this.unregister();
    }

    /** `using cache = ...` 自动释放。 */
    [Symbol.dispose](): void {
        this.unregister();
    }

    /** 应用全量快照：首帧建 baseline，之后 diff 发布归一化事件。 */
    private applySnapshot(entries: BuddyListEntry[]): void {
        if (!this.bootstrapped) {
            for (const entry of entries) {
                this.buddies.set(entry.uid, entry);
            }
            this.bootstrapped = true;
            return;
        }
        const next = new Map<string, BuddyListEntry>();
        for (const entry of entries) {
            next.set(entry.uid, entry);
        }
        for (const [uid, entry] of next) {
            if (!this.buddies.has(uid)) {
                this.events.emit("BuddyCache/onBuddyAdded", entry);
            }
        }
        for (const [uid, entry] of this.buddies) {
            if (!next.has(uid)) {
                this.events.emit("BuddyCache/onBuddyRemoved", entry);
            }
        }
        this.buddies.clear();
        for (const [uid, entry] of next) {
            this.buddies.set(uid, entry);
        }
    }

    /** 好友快照（只读拷贝）。 */
    listBuddies(): BuddyListEntry[] {
        return [...this.buddies.values()];
    }

    /** 单个好友（快照；undefined = 不在缓存）。 */
    getBuddy(uid: string): BuddyListEntry | undefined {
        return this.buddies.get(uid);
    }

    /** 快照是否已建（测试/诊断用）。 */
    get baselineReady(): boolean {
        return this.bootstrapped;
    }
}
