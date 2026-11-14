/**
 * core/uid-uin 基线测试（OB11 / Milky request 翻译共享的 uid→uin 解析）
 *
 * 锁定：映射命中 / 未命中退化 uid 数值 / 非数字 0 / 空与 undefined 0；
 * toUin（ctx 便捷形）与 toUinString（satori string 口径）同规则。
 */
import { describe, expect, it } from "vitest";
import { MS_TO_SEC, resolveUin, toUin, toUinString } from "../shared/uid-uin.js";

describe("resolveUin", () => {
    const map = new Map([
        ["uid-20002", "20002"],
        ["uid-30003", "30003"],
    ]);

    it("映射命中：取 uin 数值", () => {
        expect(resolveUin("uid-20002", map)).toBe(20002);
    });

    it("映射未命中：uid 本身是数字时直取数值（wrapper 部分回调直接给 uin）", () => {
        expect(resolveUin("10001", map)).toBe(10001);
    });

    it("映射未命中且 uid 非数字：返回 0 兜底", () => {
        expect(resolveUin("u_xxxx", map)).toBe(0);
    });

    it("空串 / undefined：返回 0", () => {
        expect(resolveUin("", map)).toBe(0);
        expect(resolveUin(undefined, map)).toBe(0);
    });

    it("MS_TO_SEC = 1000（毫秒换算常量契约）", () => {
        expect(MS_TO_SEC).toBe(1000);
    });
});

describe("toUin（ctx 便捷形：OB11 / Milky notice + request 收拢后共用）", () => {
    const ctx = { uidToUin: new Map([["uid-20002", "20002"]]) };

    it("ctx 携带映射：命中取 uin，未命中退化 uid 数值", () => {
        expect(toUin("uid-20002", ctx)).toBe(20002);
        expect(toUin("10001", ctx)).toBe(10001);
    });

    it("非数字 uid 未命中：0 兜底（与 resolveUin 同规则）", () => {
        expect(toUin("u_xxxx", ctx)).toBe(0);
        expect(toUin(undefined, ctx)).toBe(0);
    });
});

describe("toUinString（satori string 口径：资源对象保留协议串）", () => {
    const map = new Map([["uid-20002", "20002"]]);

    it("映射命中：取 uin 字符串原样（不做数值化）", () => {
        expect(toUinString("uid-20002", map)).toBe("20002");
    });

    it("映射未命中：退化 uid 原文", () => {
        expect(toUinString("uid-99999", map)).toBe("uid-99999");
        expect(toUinString("10001", map)).toBe("10001");
    });
});
