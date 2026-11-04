/**
 * package-info.test.ts：本包元数据读取单测（package-info.ts loaderVersion）。
 *
 * node:fs 部分替身（readFileSync 可注入失败 / 坏 JSON，其余透传）。
 * 覆盖：真实 package.json 版本读取、读取失败兜底 0.0.0、version 非字符串兜底。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { loaderVersion } from "./package-info.js";

/** readFileSync 失败/坏 JSON 注入（vi.hoisted：mock 工厂内可见）。 */
const h = vi.hoisted(() => {
    return {
        /** null = 透传真实实现；否则返回该字符串或抛错。 */
        mode: null as null | "throw" | "bad-json" | "no-version",
    };
});

vi.mock("node:fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs")>();
    return {
        ...actual,
        readFileSync: (path: Parameters<typeof actual.readFileSync>[0], ...rest: unknown[]) => {
            if (h.mode === "throw") {
                throw new Error("read 失败");
            }
            if (h.mode === "bad-json") {
                return "not-json{";
            }
            if (h.mode === "no-version") {
                return JSON.stringify({ name: "@napuketto/loader" });
            }
            return actual.readFileSync(path, ...(rest as []));
        },
    };
});

afterEach(() => {
    h.mode = null;
});

describe("loaderVersion", () => {
    it("读取真实 package.json → 语义化版本", () => {
        expect(loaderVersion()).toMatch(/^\d+\.\d+\.\d+/);
    });

    it("读取失败 → 兜底 0.0.0（不阻塞主流程）", () => {
        h.mode = "throw";
        expect(loaderVersion()).toBe("0.0.0");
    });

    it("JSON 解析失败 → 兜底 0.0.0", () => {
        h.mode = "bad-json";
        expect(loaderVersion()).toBe("0.0.0");
    });

    it("version 非字符串（缺失）→ 兜底 0.0.0", () => {
        h.mode = "no-version";
        expect(loaderVersion()).toBe("0.0.0");
    });
});
