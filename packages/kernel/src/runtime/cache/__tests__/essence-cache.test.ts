/**
 * essence-cache.ts 单测（ADR-028，自 adapter/internal/__tests__/essence.test.ts 迁入）
 *
 * 覆盖：群号收窄、列表 diff 四情形（首帧基线 / 新增 / 移除 / 无变化）与串行同步器
 * （基线抑制 / 回调 / 串行链 / 拉取失败不中断）。不依赖原生 service。
 */
import { describe, expect, it, vi } from "vitest";
import type { EssenceMsgItem } from "../../../apis/index.js";
import {
    diffEssenceList,
    type EssenceAddedItem,
    type EssenceCacheEntry,
    EssenceListSync,
    narrowEssenceGroupArg,
} from "../essence-cache.js";

describe("narrowEssenceGroupArg：回调参数 → 群号", () => {
    it("录制实证形状（参数数组首项字符串）", () => {
        expect(narrowEssenceGroupArg(["1101729931"])).toBe("1101729931");
    });

    it("裸字符串 / 数字 / 对象字段兜底 / 无效 → null", () => {
        expect(narrowEssenceGroupArg("1101729931")).toBe("1101729931");
        expect(narrowEssenceGroupArg(1101729931)).toBe("1101729931");
        expect(narrowEssenceGroupArg({ groupCode: "1101729931" })).toBe("1101729931");
        expect(narrowEssenceGroupArg({ peerUid: 1101729931 })).toBe("1101729931");
        expect(narrowEssenceGroupArg("")).toBeNull();
        expect(narrowEssenceGroupArg(undefined)).toBeNull();
        expect(narrowEssenceGroupArg([{ other: 1 }])).toBeNull();
    });
});

describe("diffEssenceList：列表 diff", () => {
    const item = (seq: number, adder: string, sender = "10001", time = 1): EssenceMsgItem =>
        ({
            msg_seq: seq,
            msg_random: seq,
            sender_uin: sender,
            sender_nick: "s",
            add_digest_uin: adder,
            add_digest_nick: "op",
            add_digest_time: time,
            msg_content: [],
        }) as EssenceMsgItem;

    it("基线未建立：只建缓存不产出事件", () => {
        const out = diffEssenceList(undefined, [item(1, "10001")]);
        expect(out.added).toEqual([]);
        expect(out.removed).toEqual([]);
        expect(out.cache.get(1)).toEqual({
            operatorUin: "10001",
            senderUin: "10001",
            addDigestTime: 1,
        });
    });

    it("新增 → added（operator + sender 回填）；移除 → removed", () => {
        const prev = new Map([
            [1, { operatorUin: "10001", senderUin: "10002", addDigestTime: 1 }],
            [2, { operatorUin: null, senderUin: null, addDigestTime: null }],
        ]);
        const out = diffEssenceList(prev, [item(2, "10001"), item(3, "10002", "10003")]);
        expect(out.added).toEqual([
            { messageSeq: 3, operatorUin: "10002", senderUin: "10003", addDigestTime: 1 },
        ]);
        expect(out.removed).toEqual([1]);
    });

    it("add_digest_uin / sender_uin 缺失 → null（OB11 侧省略/跳过口径）", () => {
        const prev = new Map([[1, { operatorUin: "10001", senderUin: "10001", addDigestTime: 1 }]]);
        const out = diffEssenceList(prev, [
            item(1, ""),
            item(2, "", ""),
            item(3, "10001", "10001", 0),
        ]);
        expect(out.added).toEqual([
            { messageSeq: 2, operatorUin: null, senderUin: null, addDigestTime: 1 },
            { messageSeq: 3, operatorUin: "10001", senderUin: "10001", addDigestTime: null },
        ]);
    });

    it("无变化 → 空 diff", () => {
        const prev = new Map([[1, { operatorUin: "10001", senderUin: "10001", addDigestTime: 1 }]]);
        const out = diffEssenceList(prev, [item(1, "10001")]);
        expect(out.added).toEqual([]);
        expect(out.removed).toEqual([]);
    });
});

describe("EssenceListSync：串行同步器（kernel 缓存层）", () => {
    const item = (seq: number, adder = "10001", sender = "10002"): EssenceMsgItem =>
        ({
            msg_seq: seq,
            msg_random: seq,
            sender_uin: sender,
            sender_nick: "s",
            add_digest_uin: adder,
            add_digest_nick: "op",
            add_digest_time: 1,
            msg_content: [],
        }) as EssenceMsgItem;

    function makeSync(items: EssenceMsgItem[][], fetchError: unknown = null) {
        let call = 0;
        const fetchList = vi.fn(async (): Promise<EssenceMsgItem[]> => {
            if (fetchError !== null) {
                throw fetchError;
            }
            const next = items[call];
            call += 1;
            return next ?? [];
        });
        const onAdded = vi.fn(
            async (_groupCode: string, _added: readonly EssenceAddedItem[]): Promise<void> =>
                undefined,
        );
        const onRemoved = vi.fn(
            async (
                _groupCode: string,
                _removed: readonly number[],
                _prev: ReadonlyMap<number, EssenceCacheEntry>,
            ): Promise<void> => undefined,
        );
        const onFetchError = vi.fn();
        const sync = new EssenceListSync({ fetchList, onAdded, onRemoved, onFetchError });
        return { sync, fetchList, onAdded, onRemoved, onFetchError };
    }

    it("基线未建立：首次 sync 只建缓存，不触发广播回调", async () => {
        const { sync, onAdded, onRemoved } = makeSync([[item(1)]]);
        sync.enqueue("g1");
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 0));
        expect(onAdded).not.toHaveBeenCalled();
        expect(onRemoved).not.toHaveBeenCalled();
    });

    it("基线已建立：added / removed 按 diff 结果回调（prev 供 sender 回填）", async () => {
        const { sync, onAdded, onRemoved } = makeSync([[item(1), item(2)], [item(2)]]);
        sync.enqueue("g1"); // 建基线
        await new Promise((r) => setTimeout(r, 0));
        sync.enqueue("g1"); // 移除 seq=1
        await new Promise((r) => setTimeout(r, 0));
        // 与原 adapter 行为一致：回调无条件触发，空 added 由广播侧 no-op
        expect(onAdded).toHaveBeenCalledTimes(1);
        expect(onAdded.mock.calls[0]?.[1]).toEqual([]);
        expect(onRemoved).toHaveBeenCalledTimes(1);
        const removedCall = onRemoved.mock.calls[0];
        expect(removedCall?.[0]).toBe("g1");
        expect(removedCall?.[1]).toEqual([1]);
        expect(removedCall?.[2]?.get(1)?.senderUin).toBe("10002");
    });

    it("串行链：前一 sync 未完成不启动下一 sync（并发回写乱序防线）", async () => {
        let release: (() => void) | undefined;
        const gate = new Promise<void>((r) => {
            release = r;
        });
        const order: string[] = [];
        const sync = new EssenceListSync({
            fetchList: async () => {
                order.push("fetch-start");
                await gate;
                order.push("fetch-done");
                return [];
            },
            onAdded: async () => undefined,
            onRemoved: async () => undefined,
        });
        sync.enqueue("g1");
        sync.enqueue("g1");
        await new Promise((r) => setTimeout(r, 0));
        expect(order).toEqual(["fetch-start"]); // 第二次未并行启动
        release?.();
        await new Promise((r) => setTimeout(r, 0));
        expect(order).toEqual(["fetch-start", "fetch-done", "fetch-start", "fetch-done"]);
    });

    it("fetch 失败：onFetchError 回调 + 链不中断（后续触发器继续）", async () => {
        let call = 0;
        const fetchList = vi.fn(async () => {
            call += 1;
            if (call === 1) {
                throw new Error("网络错误");
            }
            return [item(1)];
        });
        const onFetchError = vi.fn();
        const onAdded = vi.fn(async () => undefined);
        const sync = new EssenceListSync({
            fetchList,
            onAdded,
            onRemoved: async () => undefined,
            onFetchError,
        });
        sync.enqueue("g1"); // 失败
        await new Promise((r) => setTimeout(r, 0));
        expect(onFetchError).toHaveBeenCalledTimes(1);
        expect(String(onFetchError.mock.calls[0]?.[1])).toContain("网络错误");
        sync.enqueue("g1"); // 链未中断，继续
        await new Promise((r) => setTimeout(r, 0));
        expect(fetchList).toHaveBeenCalledTimes(2);
    });
});
