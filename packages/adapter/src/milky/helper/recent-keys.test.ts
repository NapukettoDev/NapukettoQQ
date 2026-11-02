/**
 * RecentKeyCache 单测（自 essence.test.ts 拆出——essence 翻译层 2026-11-03 上移 core）
 */

import { describe, expect, it } from "vitest";
import { RecentKeyCache } from "./recent-keys.js";

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
