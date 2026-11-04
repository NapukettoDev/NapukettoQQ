/**
 * qq-data-path.ts 基线测试（QQ 数据根路径解析，fallow 真实覆盖率暴露 0%）
 *
 * 锁定：
 *  - resolveQqGlobalPath：三种后缀分支（已含 nt_qq/global / 仅 nt_qq / 裸根）
 *  - extractDataRoot：JSON 字符串宽容解析（递归找 QQ 路径）/ 纯路径透传 / 非法 JSON
 */
import { describe, expect, it } from "vitest";
import { extractDataRoot, resolveQqGlobalPath } from "../qq-data-path.js";

/** 平台无关路径断言（join 在 Windows 会把 / 转成 \）。 */
function expectPathEqual(actual: string, expected: string): void {
    expect(actual.replace(/\\/g, "/")).toBe(expected.replace(/\\/g, "/"));
}

describe("resolveQqGlobalPath", () => {
    it("已含 nt_qq/global 后缀 → 原样（防重复拼接）", () => {
        expectPathEqual(resolveQqGlobalPath("D:/QQ/nt_qq/global"), "D:/QQ/nt_qq/global");
    });

    it("仅 nt_qq 后缀 → 拼 global", () => {
        expectPathEqual(resolveQqGlobalPath("D:/QQ/nt_qq"), "D:/QQ/nt_qq/global");
    });

    it("裸根 → 拼 nt_qq/global", () => {
        expectPathEqual(resolveQqGlobalPath("D:/QQ"), "D:/QQ/nt_qq/global");
    });

    it("Windows 反斜杠路径同样识别", () => {
        expectPathEqual(resolveQqGlobalPath("D:\\QQ\\nt_qq\\global"), "D:/QQ/nt_qq/global");
        expectPathEqual(resolveQqGlobalPath("D:\\QQ"), "D:/QQ/nt_qq/global");
    });
});

describe("extractDataRoot", () => {
    it("纯路径字符串 → 原样返回", () => {
        expect(extractDataRoot("C:/Users/x/Documents/Tencent Files")).toBe(
            "C:/Users/x/Documents/Tencent Files",
        );
    });

    it("JSON 对象内嵌 QQ 路径 → 递归提取", () => {
        const raw = JSON.stringify({
            config: { commonPath: "C:/Users/x/Documents/Tencent Files/xxx" },
        });
        expect(extractDataRoot(raw)).toBe("C:/Users/x/Documents/Tencent Files/xxx");
    });

    it("JSON 数组内嵌 nt_qq 路径 → 递归提取", () => {
        const raw = JSON.stringify(["a", { p: "D:/QQ/nt_qq/data" }]);
        expect(extractDataRoot(raw)).toBe("D:/QQ/nt_qq/data");
    });

    it("JSON 内无 QQ 路径特征 → null", () => {
        expect(extractDataRoot('{"a":1,"b":"c"}')).toBeNull();
    });

    it("数组内无 QQ 路径特征 → null（数组遍历耗尽）", () => {
        expect(extractDataRoot('{"list":["C:/Users/x","C:/Program Files"]}')).toBeNull();
    });

    it("非法 JSON → null（宽容不抛）", () => {
        expect(extractDataRoot("{not-json")).toBeNull();
    });
});
