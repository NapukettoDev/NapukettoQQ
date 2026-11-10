/**
 * time.test.ts：NT msgTime 单位归一（toUnixSeconds）。
 *
 * 回归 2026-11-10（Linux 原生宿主入站）：Linux wrapper 的 msgTime 是秒级字符串，
 * Windows QQNT 是毫秒字符串；不归一会让 Linux 事件时间退化成 1970。
 */
import { describe, expect, it } from "vitest";
import { toUnixSeconds } from "../shared/time.js";

describe("toUnixSeconds（msgTime 单位归一）", () => {
    it("毫秒字符串 → 秒（Windows QQNT 形态）", () => {
        expect(toUnixSeconds("1700000000000")).toBe(1_700_000_000);
        expect(toUnixSeconds("1700000000123")).toBe(1_700_000_000);
    });

    it("秒字符串 → 原样（Linux 3.2.x 原生 wrapper 形态）", () => {
        expect(toUnixSeconds("1794307394")).toBe(1_794_307_394);
    });

    it("数字输入同样按量级归一", () => {
        expect(toUnixSeconds(1_700_000_000_123)).toBe(1_700_000_000);
        expect(toUnixSeconds(1_794_307_394)).toBe(1_794_307_394);
    });

    it("空 / 非法 / 非正 → 0（调用方决定兜底）", () => {
        expect(toUnixSeconds(undefined)).toBe(0);
        expect(toUnixSeconds("")).toBe(0);
        expect(toUnixSeconds("abc")).toBe(0);
        expect(toUnixSeconds("0")).toBe(0);
        expect(toUnixSeconds(-1)).toBe(0);
    });
});
