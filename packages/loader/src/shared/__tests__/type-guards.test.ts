/**
 * type-guards.test.ts：shared 运行时类型守卫独立单测（2026-11-25 P2 补齐盲区）。
 *
 * 这些守卫是 loader 动态 import / IPC 参数 / 原生反射对象收窄的公共底座：
 * 守卫误判会让调用点拿到未校验对象（运行期才炸），因此逐分支断言。
 * 其中 getErrorMessage 的语义用例原在 host/__tests__/util-config-error.test.ts，
 * 随实现下沉到 shared/ 一并迁到本文件（同一模块的单测不跨目录分散）。
 */
import { describe, expect, it } from "vitest";
import {
    getErrorCode,
    getErrorMessage,
    getOwnProp,
    hasCallableProp,
    hasMethodSurface,
    isCallable,
    isRecord,
    parseJsonWithGuard,
} from "../type-guards.js";

describe("isRecord（非 null、非数组的普通对象）", () => {
    it("对象字面量 / 类实例 → true", () => {
        expect(isRecord({})).toBe(true);
        expect(isRecord({ a: 1 })).toBe(true);
        expect(isRecord(new Date())).toBe(true);
    });

    it("数组 / null / 基本类型 / 函数 / undefined → false", () => {
        expect(isRecord([])).toBe(false);
        expect(isRecord(null)).toBe(false);
        expect(isRecord(undefined)).toBe(false);
        expect(isRecord("x")).toBe(false);
        expect(isRecord(1)).toBe(false);
        expect(isRecord(true)).toBe(false);
        expect(isRecord(() => undefined)).toBe(false);
    });
});

describe("isCallable（可调用函数）", () => {
    it("普通函数 / 箭头函数 / 类构造器 → true", () => {
        expect(isCallable(() => undefined)).toBe(true);
        expect(isCallable(() => 1)).toBe(true);
        expect(isCallable(class {})).toBe(true);
    });

    it("对象 / null / 字符串 → false", () => {
        expect(isCallable({})).toBe(false);
        expect(isCallable(null)).toBe(false);
        expect(isCallable("fn")).toBe(false);
    });
});

describe("getOwnProp（含原型链 / 函数对象的安全属性读取）", () => {
    it("own 属性 / 原型方法 / 函数对象属性均可读", () => {
        expect(getOwnProp({ a: 1 }, "a")).toBe(1);
        const proto = { inherited: "p" };
        expect(getOwnProp(Object.create(proto) as object, "inherited")).toBe("p");
        const fn = Object.assign(() => undefined, { extra: "e" });
        expect(getOwnProp(fn, "extra")).toBe("e");
    });

    it("不存在的键 / 原始值 / null → undefined（不抛）", () => {
        expect(getOwnProp({}, "missing")).toBeUndefined();
        expect(getOwnProp("str", "length")).toBeUndefined();
        expect(getOwnProp(null, "a")).toBeUndefined();
        expect(getOwnProp(undefined, "a")).toBeUndefined();
    });
});

describe("hasCallableProp（对象/构造器具备可调用方法）", () => {
    it("方法存在 → true，并可收窄后直接调用", () => {
        const val: unknown = { start: () => "ok" };
        if (!hasCallableProp(val, "start")) {
            throw new Error("守卫应命中");
        }
        expect(val.start()).toBe("ok");
    });

    it("函数对象上的属性同样命中（构造器静态方法同构）", () => {
        const ctor = (): undefined => undefined;
        Object.assign(ctor, { create: () => "created" });
        expect(hasCallableProp(ctor, "create")).toBe(true);
    });

    it("属性不存在 / 非函数 / null → false", () => {
        expect(hasCallableProp({ start: 1 }, "start")).toBe(false);
        expect(hasCallableProp({}, "start")).toBe(false);
        expect(hasCallableProp(null, "start")).toBe(false);
        expect(hasCallableProp(42, "start")).toBe(false);
    });
});

describe("hasMethodSurface（同时具备一组方法）", () => {
    it("全部方法存在 → true；缺一个 → false", () => {
        const obj = { a: () => 1, b: () => 2 };
        expect(hasMethodSurface(obj, ["a", "b"] as const)).toBe(true);
        expect(hasMethodSurface(obj, ["a", "c"] as const)).toBe(false);
    });

    it("空方法列表 → 任意对象成立；null → false", () => {
        expect(hasMethodSurface({}, [] as const)).toBe(true);
        expect(hasMethodSurface(null, ["a"] as const)).toBe(false);
    });
});

describe("getErrorCode（系统错误码提取）", () => {
    it("字符串 code → 原样返回", () => {
        expect(getErrorCode({ code: "ENOENT" })).toBe("ENOENT");
        expect(getErrorCode(Object.assign(new Error("x"), { code: "ESRCH" }))).toBe("ESRCH");
    });

    it("非字符串 code / 非对象 / null → undefined", () => {
        expect(getErrorCode({ code: 1 })).toBeUndefined();
        expect(getErrorCode({})).toBeUndefined();
        expect(getErrorCode("ENOENT")).toBeUndefined();
        expect(getErrorCode(null)).toBeUndefined();
    });
});

describe("getErrorMessage（错误信息提取，保留 JS 原语义）", () => {
    it("Error → message", () => {
        expect(getErrorMessage(new Error("boom"))).toBe("boom");
    });

    it("带 message 的非 Error 对象 → message", () => {
        expect(getErrorMessage({ message: "原生断言" })).toBe("原生断言");
    });

    it("无 message 对象 / 字符串 / 数字 → String(e)", () => {
        expect(getErrorMessage({})).toBe("[object Object]");
        expect(getErrorMessage("裸字符串")).toBe("裸字符串");
        expect(getErrorMessage(42)).toBe("42");
    });

    it("null / undefined → String(e)", () => {
        expect(getErrorMessage(null)).toBe("null");
        expect(getErrorMessage(undefined)).toBe("undefined");
    });
});

describe("parseJsonWithGuard（解析 + 守卫，失败均返回 null）", () => {
    const isNumberRecord = (val: unknown): val is { n: number } =>
        isRecord(val) && typeof val["n"] === "number";

    it("合法 JSON 且通过守卫 → 返回解析值", () => {
        expect(parseJsonWithGuard('{"n":1}', isNumberRecord)).toEqual({ n: 1 });
    });

    it("合法 JSON 但守卫拒绝 → null", () => {
        expect(parseJsonWithGuard('{"n":"1"}', isNumberRecord)).toBeNull();
        expect(parseJsonWithGuard("[1]", isNumberRecord)).toBeNull();
    });

    it("非法 JSON → null（不抛）", () => {
        expect(parseJsonWithGuard("{", isNumberRecord)).toBeNull();
        expect(parseJsonWithGuard("", isNumberRecord)).toBeNull();
    });
});
