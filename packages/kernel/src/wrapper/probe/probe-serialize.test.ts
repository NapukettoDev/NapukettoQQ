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
        const big = Array.from({ length: 70 }, (_, i) => `s${i}`);
        expect(serialize(big)).toHaveLength(64);
    });

    it("字节形态数组 / TypedArray → base64 全量保留（截断标注）", () => {
        const signed = Array.from({ length: 40 }, (_, i) => (i % 256) - 128);
        const out = serialize(signed) as Record<string, unknown>;
        expect(out["kind"]).toBe("bytes");
        expect(out["size"]).toBe(40);
        expect(out["truncated"]).toBeUndefined();
        // 负字节按无符号还原：第 39 项源值 = 39 - 128 = -89 → 167
        const back = Buffer.from(out["data"] as string, "base64");
        expect(back[39]).toBe(167);

        const huge = new Uint8Array(9000).fill(7);
        const out2 = serialize(huge) as Record<string, unknown>;
        expect(out2["kind"]).toBe("bytes");
        expect(out2["size"]).toBe(9000);
        expect(out2["truncated"]).toBe(9000 - 8192);
        expect(Buffer.from(out2["data"] as string, "base64")).toHaveLength(8192);
    });

    it("短数字数组不按字节形态处理", () => {
        expect(serialize([1, 2, 3])).toEqual([1, 2, 3]);
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
        // 12 层嵌套，深度上限 8：第 9 层起截断
        let deep: unknown = 1;
        for (let i = 0; i < 12; i += 1) {
            deep = { v: deep };
        }
        const walk = (node: unknown, n: number): unknown =>
            n === 0 ? node : walk((node as Record<string, unknown>)["v"], n - 1);
        expect(walk(serialize(deep), 9)).toBe("[depth-limit]");
        expect(walk(serialize(deep), 8)).toEqual({ v: "[depth-limit]" });
    });

    it("循环引用 → 深度受限不死循环", () => {
        const obj: Record<string, unknown> = { name: "self" };
        obj["self"] = obj;
        const out = serialize(obj) as Record<string, unknown>;
        const self1 = out["self"] as Record<string, unknown>;
        const self2 = self1["self"] as Record<string, unknown>;
        expect(self2).toBeInstanceOf(Object);
        let node: unknown = out;
        for (let i = 0; i < 8; i += 1) {
            node = (node as Record<string, unknown>)["self"];
        }
        expect((node as Record<string, unknown>)["self"]).toBe("[depth-limit]");
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
