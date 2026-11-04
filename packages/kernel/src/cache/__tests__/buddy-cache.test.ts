/**
 * buddy-cache.ts 测试（B2，2026-09-08）
 *
 * 覆盖快照 diff 四情形（首帧 baseline / 新增 / 删除 / 无变化）+
 * 收窄函数 + 未知载荷 raw 日志 + unregister 幂等。
 * 用真实 NTEventChannel + BuddyCache 自带 diff 通道,不依赖原生 service。
 */
import { describe, expect, it, vi } from "vitest";
import { NTEventChannel } from "../../event-channel.js";
import type { BuddyListener } from "../../types/index.js";
import { BuddyCache, narrowBuddyCategories } from "../buddy-cache.js";

function makeCache() {
    const channel = new NTEventChannel<BuddyListener, "Buddy">("Buddy");
    const logger = { warn: vi.fn(), info: vi.fn() };
    const cache = new BuddyCache({ channel, logger });
    return { channel, cache, logger };
}

/** 快照工厂(单分类 N 好友)。 */
function snapshot(...uids: string[]): unknown {
    return [
        {
            categoryId: 0,
            categroyName: "我的好友",
            categroyMbCount: uids.length,
            buddyList: uids.map((uid, i) => ({
                uid,
                uin: `1000${i}`,
                coreInfo: { uid, uin: `1000${i}`, nick: `N${i}` },
            })),
        },
    ];
}

describe("narrowBuddyCategories", () => {
    it("BuddyCategory[] 直返;非数组返回 null", () => {
        expect(narrowBuddyCategories(snapshot("u1"))).toHaveLength(1);
        expect(narrowBuddyCategories(true)).toBeNull();
        expect(narrowBuddyCategories([{ bad: 1 }, "x"])).toBeNull();
    });
});

describe("快照 diff(四情形)", () => {
    it("首帧 baseline:不发任何事件", () => {
        const { channel, cache } = makeCache();
        const added = vi.fn();
        cache.events.on("BuddyCache/onBuddyAdded", added);
        cache.register();
        channel.emit("Buddy/onBuddyListChange", snapshot("u1", "u2"));
        expect(added).not.toHaveBeenCalled();
        expect(cache.baselineReady).toBe(true);
        expect(cache.listBuddies()).toHaveLength(2);
        expect(cache.getBuddy("u1")?.uin).toBe("10000");
        cache.unregister();
    });

    it("第二帧新增 → onBuddyAdded(仅新增项)", () => {
        const { channel, cache } = makeCache();
        const added = vi.fn();
        cache.events.on("BuddyCache/onBuddyAdded", added);
        cache.register();
        channel.emit("Buddy/onBuddyListChange", snapshot("u1"));
        channel.emit("Buddy/onBuddyListChange", snapshot("u1", "u2", "u3"));
        expect(added).toHaveBeenCalledTimes(2);
        expect(added.mock.calls.map((c) => c[0].uid).sort()).toEqual(["u2", "u3"]);
        cache.unregister();
    });

    it("第二帧删除 → onBuddyRemoved", () => {
        const { channel, cache } = makeCache();
        const removed = vi.fn();
        cache.events.on("BuddyCache/onBuddyRemoved", removed);
        cache.register();
        channel.emit("Buddy/onBuddyListChange", snapshot("u1", "u2"));
        channel.emit("Buddy/onBuddyListChange", snapshot("u1"));
        expect(removed).toHaveBeenCalledTimes(1);
        const [firstCall] = removed.mock.calls;
        expect(firstCall?.[0].uid).toBe("u2");
        expect(cache.listBuddies()).toHaveLength(1);
        cache.unregister();
    });

    it("无变化 → 不发事件;快照内容更新(备注变化仍同 uid)", () => {
        const { channel, cache } = makeCache();
        const added = vi.fn();
        const removed = vi.fn();
        cache.events.on("BuddyCache/onBuddyAdded", added);
        cache.events.on("BuddyCache/onBuddyRemoved", removed);
        cache.register();
        channel.emit("Buddy/onBuddyListChange", snapshot("u1"));
        channel.emit("Buddy/onBuddyListChange", snapshot("u1"));
        expect(added).not.toHaveBeenCalled();
        expect(removed).not.toHaveBeenCalled();
        cache.unregister();
    });
});

describe("未知载荷与生命周期", () => {
    it("非数组载荷(boolean/undefined)→ raw warn 日志,不影响已有快照", () => {
        const { channel, cache, logger } = makeCache();
        cache.register();
        channel.emit("Buddy/onBuddyListChange", snapshot("u1"));
        channel.emit("Buddy/onBuddyListChange", true);
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(cache.listBuddies()).toHaveLength(1);
        cache.unregister();
    });

    it("register/unregister 幂等;unregister 清空快照并复位 baseline", () => {
        const { channel, cache } = makeCache();
        cache.register();
        cache.register();
        channel.emit("Buddy/onBuddyListChange", snapshot("u1"));
        cache.unregister();
        cache.unregister();
        expect(cache.listBuddies()).toHaveLength(0);
        expect(cache.baselineReady).toBe(false);
        // 重新 register 后第一帧又是 baseline(不发事件)
        const added = vi.fn();
        cache.events.on("BuddyCache/onBuddyAdded", added);
        cache.register();
        channel.emit("Buddy/onBuddyListChange", snapshot("u1"));
        expect(added).not.toHaveBeenCalled();
        cache.unregister();
    });
});

describe("拍平边界补充", () => {
    it("分类缺 buddyList → 该分类跳过（不炸）", async () => {
        const { cache, channel } = makeCache();
        cache.register();
        channel.emit("Buddy/onBuddyListChange", [
            { categoryId: 1, categorySortId: 0, categroyName: "无明细" },
            {
                categoryId: 2,
                categorySortId: 1,
                categroyName: "有明细",
                buddyList: [{ uid: "u1", uin: "10001", nick: "A" }],
            },
        ] as never);
        expect(cache.listBuddies()).toHaveLength(1);
    });

    it("buddyList 内 uid 非字符串 / 空串 → 条目跳过", async () => {
        const { cache, channel } = makeCache();
        cache.register();
        channel.emit("Buddy/onBuddyListChange", [
            {
                categoryId: 1,
                categorySortId: 0,
                categroyName: "脏数据",
                buddyList: [{ uid: "", uin: "1" }, { uin: "2" }, { uid: "u9", uin: "9" }],
            },
        ] as never);
        const list = cache.listBuddies();
        expect(list).toHaveLength(1);
        expect(list[0]?.uid).toBe("u9");
    });
});
