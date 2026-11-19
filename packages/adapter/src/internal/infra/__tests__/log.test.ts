/**
 * infra/log.test.ts：raw 日志双截断口径 + 事件失败留痕单测（四协议共用）。
 *
 * 锁定：truncRaw 的 64 缺省上限与 `…(+N)` 长度标注、sliceRaw 的 2000 固定切片
 * （无标注）与自定义上限、logEventFailure 的缺省静默 / warn 调用形状 /
 * 非 Error 原始值的 errorMessage 归一。
 */

import { describe, expect, it, vi } from "vitest";
import { type AdapterLoggerLike, logEventFailure, sliceRaw, truncRaw } from "../log.js";

/** 构造实现 AdapterLoggerLike 的 spy logger（强类型，不做暴力强转）。 */
function makeLogger() {
    return {
        warn: vi.fn<(obj: unknown, msg?: string) => void>(),
        info: vi.fn<(obj: unknown, msg?: string) => void>(),
        debug: vi.fn<(obj: unknown, msg?: string) => void>(),
    } satisfies AdapterLoggerLike;
}

describe("truncRaw（info/warn 级 64 缺省口径）", () => {
    it("undefined → 空串", () => {
        expect(truncRaw(undefined)).toBe("");
    });

    it("空串 / 恰好等于上限 → 原样返回，不追加后缀", () => {
        expect(truncRaw("")).toBe("");
        expect(truncRaw("a".repeat(64))).toBe("a".repeat(64));
    });

    it("超过上限 1 字符 → 前 64 字符 + …(+1)", () => {
        expect(truncRaw("a".repeat(65))).toBe(`${"a".repeat(64)}…(+1)`);
    });

    it("自定义 keep → 按 keep 截断并标注缺失长度", () => {
        expect(truncRaw("abcdef", 4)).toBe("abcd…(+2)");
    });
});

describe("sliceRaw（debug / 长文本 2000 固定切片口径）", () => {
    it("undefined → 空串", () => {
        expect(sliceRaw(undefined)).toBe("");
    });

    it("恰好等于上限 → 原样返回", () => {
        expect(sliceRaw("x".repeat(2000))).toBe("x".repeat(2000));
    });

    it("超过上限 → 固定切片且不带 …(+N) 标注", () => {
        const result = sliceRaw("x".repeat(2005));
        expect(result).toBe("x".repeat(2000));
        expect(result).not.toContain("…(+");
    });

    it("自定义 max → 取前 max 字符", () => {
        expect(sliceRaw("abcdef", 3)).toBe("abc");
    });
});

describe("logEventFailure（事件链失败留痕）", () => {
    it("logger 缺省 → 静默返回不抛错", () => {
        expect(() => {
            logEventFailure(undefined, "ob11: 失败", new Error("boom"));
        }).not.toThrow();
    });

    it("Error 入参 → warn({ err: message }, msg) 一次", () => {
        const logger = makeLogger();
        logEventFailure(logger, "ob11: 失败", new Error("boom"));
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith({ err: "boom" }, "ob11: 失败");
        expect(logger.info).not.toHaveBeenCalled();
        expect(logger.debug).not.toHaveBeenCalled();
    });

    it("非 Error 原始值 → errorMessage 归一为字符串后交给 warn", () => {
        const logger = makeLogger();
        logEventFailure(logger, "ob11: 失败", "raw err");
        expect(logger.warn).toHaveBeenCalledWith({ err: "raw err" }, "ob11: 失败");
    });
});
