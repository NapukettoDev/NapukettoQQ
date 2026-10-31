/**
 * probe-utils.ts 基线测试（fallow 重构目标，untested risk）
 *
 * 覆盖运行时反射基础工具：
 *  - listMethods：原型链 + 自有属性枚举（去重、去构造器、排序）
 *  - tryCall：安全调用（成功/非函数/抛异常）
 *  - isServiceGetter（get*Service 命名约定）
 */
import { describe, expect, it, vi } from "vitest";
import { isServiceGetter, listMethods, tryCall } from "./probe-utils.js";

describe("listMethods", () => {
    it("null/undefined 返回空数组", () => {
        expect(listMethods(null)).toEqual([]);
        expect(listMethods(undefined)).toEqual([]);
    });

    it("枚举实例原型链方法（去重去构造器排序）", () => {
        class Base {
            alpha(): void {
                // 测试桩：仅验证方法枚举，无需实现
            }
        }
        class Sub extends Base {
            beta(): void {
                // 测试桩：仅验证方法枚举，无需实现
            }
            gamma(): void {
                // 测试桩：仅验证方法枚举，无需实现
            }
        }
        const methods = listMethods(new Sub());
        expect(methods).toEqual(["alpha", "beta", "gamma"]);
    });

    it("自有属性方法并入", () => {
        const obj = {
            own: () => {
                /* 测试桩 */
            },
            data: 1,
        };
        expect(listMethods(obj)).toEqual(["data", "own"]);
    });

    it("普通对象不含 Object.prototype 方法", () => {
        const methods = listMethods({
            a: () => {
                /* 测试桩 */
            },
        });
        expect(methods).toEqual(["a"]);
    });

    it("函数对象不含 Function.prototype 方法", () => {
        const fn = () => {
            /* 测试桩 */
        };
        const methods = listMethods(fn);
        // 函数自有属性（length/name）会被收集，但不含 apply/call/bind 等原型方法
        expect(methods).not.toContain("apply");
        expect(methods).not.toContain("bind");
        expect(methods).not.toContain("call");
    });

    it("原型链去重（同名覆盖）", () => {
        class Base {
            same(): void {
                // 测试桩：仅验证方法枚举，无需实现
            }
        }
        class Sub extends Base {
            override same(): void {
                // 测试桩：仅验证方法枚举，无需实现
            }
        }
        expect(listMethods(new Sub())).toEqual(["same"]);
    });
});

describe("tryCall", () => {
    it("成功调用返回 ok + value", () => {
        const obj = { fn: () => 42 };
        expect(tryCall(obj, "fn")).toEqual({ ok: true, value: 42 });
    });

    it("方法缺失返回 ok=false + not a function", () => {
        expect(tryCall({}, "missing")).toEqual({
            ok: false,
            error: "not a function (typeof=undefined)",
        });
    });

    it("非函数字段返回 ok=false", () => {
        expect(tryCall({ n: 1 }, "n")).toEqual({
            ok: false,
            error: "not a function (typeof=number)",
        });
    });

    it("调用抛异常返回 ok=false + 错误消息", () => {
        const obj = {
            fn: () => {
                throw new Error("boom");
            },
        };
        expect(tryCall(obj, "fn")).toEqual({ ok: false, error: "boom" });
    });

    it("非 Error 异常转为字符串", () => {
        const obj = {
            fn: () => {
                throw "raw";
            },
        };
        expect(tryCall(obj, "fn")).toEqual({ ok: false, error: "raw" });
    });

    it("以 obj 为 this 调用（方法内引用 this）", () => {
        const obj = {
            n: 7,
            fn() {
                return this.n;
            },
        };
        expect(tryCall(obj, "fn")).toEqual({ ok: true, value: 7 });
    });

    it("vi.fn 透传（确保不是调用 mock 本身）", () => {
        const fn = vi.fn(() => "ok");
        expect(tryCall({ fn }, "fn")).toEqual({ ok: true, value: "ok" });
        expect(fn).toHaveBeenCalledTimes(1);
    });
});

describe("isServiceGetter", () => {
    it("get*Service 命名判定", () => {
        expect(isServiceGetter("getMsgService")).toBe(true);
        expect(isServiceGetter("getService")).toBe(true);
        expect(isServiceGetter("getMsg")).toBe(false);
        expect(isServiceGetter("sendMessage")).toBe(false);
        expect(isServiceGetter("getMsgServiceList")).toBe(false);
    });
});
