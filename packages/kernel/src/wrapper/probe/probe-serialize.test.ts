/**
 * probe-serialize.ts 基线测试（fallow refactoring target #4，untested risk）
 * 锁定 serialize / tryShape 现有行为，重构后回归。
 */
import { describe, expect, it } from "vitest";
import { serialize, tryShape } from "./probe-serialize.js";

describe("serialize", () => {
    it("null / undefined / 原始值原样返回", () => {
        expect(serialize(null)).toBeNull();
        expect(serialize(undefined)).toBeUndefined();
        expect(serialize(42)).toBe(42);
        expect(serialize("str")).toBe("str");
        expect(serialize(true)).toBe(true);
    });

    it("bigint 转字符串", () => {
        expect(serialize(123n)).toBe("123");
    });

    it("function → [function name]", () => {
        expect(
            serialize(function abc() {
                // 空函数体：serialize 仅取函数名
            }),
        ).toBe("[function abc]");
        expect(
            serialize(() => {
                // 空函数体：serialize 仅取函数名
            }),
        ).toBe("[function ]");
    });

    it("数组递归 + 截断上限", () => {
        expect(serialize([1, "a", null])).toEqual([1, "a", null]);
        const big = Array.from({ length: 30 }, (_, i) => i);
        expect(serialize(big)).toHaveLength(20);
    });

    it("Map → { kind, size, entries }", () => {
        const m = new Map<string, string | number>([
            ["k", 1],
            ["n", "v"],
        ]);
        expect(serialize(m)).toEqual({ kind: "Map", size: 2, entries: { k: 1, n: "v" } });
    });

    it("Set → { kind, size, values }", () => {
        const s = new Set(["a", "b"]);
        expect(serialize(s)).toEqual({ kind: "Set", size: 2, values: ["a", "b"] });
    });

    it("Promise → [Promise]", () => {
        expect(serialize(Promise.resolve(1))).toBe("[Promise]");
    });

    it("普通对象递归 + 键截断", () => {
        expect(serialize({ a: 1, b: { c: 2 } })).toEqual({ a: 1, b: { c: 2 } });
        const wide: Record<string, number> = {};
        for (let i = 0; i < 60; i += 1) {
            wide[`k${i}`] = i;
        }
        expect(Object.keys(serialize(wide) as Record<string, unknown>)).toHaveLength(50);
    });

    it("深度限制 → [depth-limit]", () => {
        const deep = { a: { b: { c: { d: { e: { f: 1 } } } } } };
        const out = serialize(deep) as Record<string, unknown>;
        const outA = out["a"] as Record<string, unknown>;
        const outB = outA["b"] as Record<string, unknown>;
        const outC = outB["c"] as Record<string, unknown>;
        const outD = outC["d"] as Record<string, unknown>;
        expect(outD["e"]).toBe("[depth-limit]");
    });

    it("循环引用 → 深度受限不死循环", () => {
        const obj: Record<string, unknown> = { name: "self" };
        obj["self"] = obj;
        const out = serialize(obj) as Record<string, unknown>;
        const self1 = out["self"] as Record<string, unknown>;
        const self2 = self1["self"] as Record<string, unknown>;
        const self3 = self2["self"] as Record<string, unknown>;
        const self4 = self3["self"] as Record<string, unknown>;
        expect(self4["self"]).toBe("[depth-limit]");
    });

    it("不可序列化（Proxy 抛异常）→ [unserializable]", () => {
        const poison = new Proxy(
            {},
            {
                ownKeys: () => {
                    throw new Error("boom");
                },
            },
        );
        expect(serialize(poison)).toBe("[unserializable]");
    });
});

describe("tryShape", () => {
    it("getter 为函数 → 序列化调用结果", () => {
        const session = { getName: () => "Napuketto" };
        expect(tryShape(session, "getName")).toBe("Napuketto");
    });

    it("getter 非函数 / 缺失 → null", () => {
        expect(tryShape({}, "nope")).toBeNull();
        expect(tryShape({ nope: 42 }, "nope")).toBeNull();
    });

    it("调用抛异常 → [error]", () => {
        const session = {
            boom: () => {
                throw new Error("x");
            },
        };
        expect(tryShape(session, "boom")).toBe("[error]");
    });
});
