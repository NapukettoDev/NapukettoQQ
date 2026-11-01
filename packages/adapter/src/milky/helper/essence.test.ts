/**
 * 精华 diff 翻译单测（批次三）
 */

import type { EssenceMsgItem } from "@napuketto/kernel";
import { describe, expect, it } from "vitest";
import { diffEssenceList, narrowEssenceGroupArg } from "./essence.js";
import { RecentKeyCache } from "./recent-keys.js";

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
    const item = (seq: number, adder: string): EssenceMsgItem =>
        ({
            msg_seq: seq,
            msg_random: seq,
            sender_uin: "10001",
            sender_nick: "s",
            add_digest_uin: adder,
            add_digest_nick: "op",
            add_digest_time: 1,
            msg_content: [],
        }) as EssenceMsgItem;

    it("基线未建立：只建缓存不产出事件", () => {
        const out = diffEssenceList(undefined, [item(1, "10001")]);
        expect(out.added).toEqual([]);
        expect(out.removed).toEqual([]);
        expect(out.cache.get(1)).toBe("10001");
    });

    it("新增 → added（operator = add_digest_uin）；移除 → removed", () => {
        const prev = new Map<number, string>([
            [1, "10001"],
            [2, ""],
        ]);
        const out = diffEssenceList(prev, [item(2, "10001"), item(3, "10002")]);
        expect(out.added).toEqual([{ messageSeq: 3, operatorUin: "10002" }]);
        expect(out.removed).toEqual([1]);
    });

    it("add_digest_uin 缺失 → operatorUin null（快路径/取消场景省略口径一致）", () => {
        const prev = new Map<number, string>([[1, "10001"]]);
        const out = diffEssenceList(prev, [item(1, ""), item(2, "")]);
        expect(out.added).toEqual([{ messageSeq: 2, operatorUin: null }]);
    });

    it("无变化 → 空 diff", () => {
        const prev = new Map<number, string>([[1, "10001"]]);
        const out = diffEssenceList(prev, [item(1, "10001")]);
        expect(out.added).toEqual([]);
        expect(out.removed).toEqual([]);
    });
});

describe("RecentKeyCache：去重键缓存", () => {
    it("claim 首次 true；窗口内重复 false；过期后重新 true", () => {
        const cache = new RecentKeyCache(5000);
        expect(cache.claim("k", 1000)).toBe(true);
        expect(cache.claim("k", 3000)).toBe(false);
        expect(cache.claim("k", 7000)).toBe(true); // 1000+5000 已过期
    });

    it("不同键互不影响", () => {
        const cache = new RecentKeyCache(5000);
        expect(cache.claim("a", 1000)).toBe(true);
        expect(cache.claim("b", 1000)).toBe(true);
        expect(cache.claim("a", 1000)).toBe(false);
    });
});
