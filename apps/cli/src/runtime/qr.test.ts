/**
 * qr.test.ts：终端二维码渲染单测（2026-11-03 用 uqr 替换 qrcode 包时补）。
 *
 * 渲染器是「矩阵 → ANSI 文本」的纯函数，测试反过来把文本解析回矩阵：
 * 只要 roundtrip 与 uqr `encode` 的矩阵一致、每行宽度等于模块数、样式前缀
 * 恒定，就说明极性（白底黑块）、静区、奇数行补齐都没有画错——终端显示时
 * 手机扫到的就是 uqr 编码的那张码。
 */
import { encode } from "uqr";
import { describe, expect, it } from "vitest";
import { renderQrAnsi } from "./qr.js";

const STYLE = "\x1b[47m\x1b[30m";
const RESET = "\x1b[0m";

/** 去掉样式前缀/复位（渲染器只会输出这两种序列，无需通用 ANSI 正则——biome 禁控制字符正则）。 */
function stripStyle(line: string): string {
    return line.replaceAll(STYLE, "").replaceAll(RESET, "");
}

/** 解析渲染结果：每个字符行还原成矩阵的两行（`▀` 上半、`▄` 下半、`█` 全暗、空格全亮）。 */
function parseRendered(rendered: string): boolean[][] {
    const rows: boolean[][] = [];
    for (const rawLine of rendered.split("\n")) {
        const line = stripStyle(rawLine);
        const upper: boolean[] = [];
        const lower: boolean[] = [];
        for (const ch of line) {
            upper.push(ch === "█" || ch === "▀");
            lower.push(ch === "█" || ch === "▄");
        }
        rows.push(upper, lower);
    }
    return rows;
}

const URL = "https://txz.qq.com/p?k=0123456789abcdef0123456789abcdef&f=0512";

describe("renderQrAnsi", () => {
    it("roundtrip：解析回的矩阵与 uqr 编码矩阵一致", () => {
        const expected = encode(URL, { ecc: "M", border: 1 }).data;
        const parsed = parseRendered(renderQrAnsi(URL));
        expect(parsed.slice(0, expected.length)).toEqual(expected);
    });

    it("宽度等于模块数（每模块一个字符，不得出现全角双宽格）", () => {
        const { data } = encode(URL, { ecc: "M", border: 1 });
        const widths = renderQrAnsi(URL)
            .split("\n")
            .map((line) => stripStyle(line).length);
        expect(new Set(widths)).toEqual(new Set([data[0]?.length]));
    });

    it("每行都是白底黑块样式且以 reset 收尾（不污染后续日志）", () => {
        for (const line of renderQrAnsi(URL).split("\n")) {
            expect(line.startsWith(STYLE)).toBe(true);
            expect(line.endsWith(RESET)).toBe(true);
        }
    });

    it("矩阵高度为奇数时末行下半按静区补齐（多出的半行全亮）", () => {
        const { data } = encode(URL, { ecc: "M", border: 1 });
        expect(data.length % 2).toBe(1);
        const parsed = parseRendered(renderQrAnsi(URL));
        expect(parsed).toHaveLength(data.length + 1);
        expect(parsed.at(-1)?.every((dark) => !dark)).toBe(true);
    });
});
