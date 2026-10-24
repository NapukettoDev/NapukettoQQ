/**
 * json-safe.test.ts：toJsonSafe（IPC 出站负载 JSON 安全化）单测。
 *
 * 锁定 2026-10-24 线上事故的修复语义：JSON.stringify 对 Map/Set 内容全丢
 * （Map → {}、Set → []），编码前必须规整，否则视频缩略图路径等跨进程即丢。
 */
import { describe, expect, it } from "vitest";
import { toJsonSafe } from "../json-safe.js";

describe("toJsonSafe", () => {
    it("原始值原样返回", () => {
        expect(toJsonSafe(1)).toBe(1);
        expect(toJsonSafe("s")).toBe("s");
        expect(toJsonSafe(true)).toBe(true);
        expect(toJsonSafe(null)).toBe(null);
        expect(toJsonSafe(undefined)).toBe(undefined);
    });

    it("Map → 平面对象（数字 key 变字符串，值递归）", () => {
        const input = new Map<number, unknown>([
            [0, "/thumb.png"],
            [1, new Map([["inner", "v"]])],
        ]);
        expect(toJsonSafe(input)).toEqual({ "0": "/thumb.png", "1": { inner: "v" } });
    });

    it("Set → 数组（值递归）", () => {
        expect(toJsonSafe(new Set([1, new Set([2])]))).toEqual([1, [2]]);
    });

    it("数组/嵌套普通对象递归", () => {
        const input = { a: [new Map([["k", "v"]])], b: { c: new Set(["x"]) } };
        expect(toJsonSafe(input)).toEqual({ a: [{ k: "v" }], b: { c: ["x"] } });
    });

    it("视频缩略图线上形态：嵌套 videoElement.thumbPath Map<0, path> 被保留", () => {
        const msg = {
            elements: [
                {
                    elementType: 5,
                    videoElement: { filePath: "/v.mp4", thumbPath: new Map([[0, "/t.png"]]) },
                },
            ],
        };
        const safe = toJsonSafe(msg) as typeof msg & {
            elements: Array<{ videoElement: { thumbPath: Record<string, string> } }>;
        };
        expect(safe.elements[0]?.videoElement.thumbPath["0"]).toBe("/t.png");
    });

    it("非普通对象（Date 等）原样引用，不递归改写", () => {
        const date = new Date(0);
        const out = toJsonSafe({ at: date }) as { at: unknown };
        expect(out.at).toBe(date);
    });

    it("环引用：丢弃回边分支，不死循环（stringify 遇环整条消息抛错，丢分支严格更优）", () => {
        const node: { name: string; self?: unknown } = { name: "n" };
        node.self = node;
        expect(toJsonSafe(node)).toEqual({ name: "n" });
    });

    it("DAG 重复引用（非环）：两处都保留", () => {
        const shared = { id: 1 };
        const out = toJsonSafe({ a: shared, b: shared });
        expect(out).toEqual({ a: { id: 1 }, b: { id: 1 } });
    });

    it("幂等：已规整负载再跑一遍结果不变", () => {
        const input = { m: new Map([["k", new Set([1, 2])]]) };
        const once = toJsonSafe(input);
        expect(toJsonSafe(once)).toEqual(once);
    });
});
