/**
 * 终端二维码渲染（uqr 编码 + half-block ANSI，2026-11-03 替代 qrcode 包）
 *
 * 登录二维码要贴进终端给手机扫，而 uqr 自带的两个终端渲染器都不合用：
 * - `renderANSI`：每个模块占一个全角空格（U+3000），宽度翻倍——登录 URL 编码出来
 *   动辄 40+ 模块，80 列终端里直接折行，折行即废码；
 * - `renderUnicodeCompact`：用**默认前景色**画亮模块，极性跟着终端主题走——浅色主题下
 *   整张码反色，扫码成功率不可靠。
 *
 * 因此这里只取 uqr 的编码结果，按旧 qrcode `terminal + small` 的观感自行绘制：
 * 白底（`\x1b[47m`）+ 黑模块（`\x1b[30m`），两行模块压进一个 `▀▄█` 字符行。
 * 好处是与终端主题无关、宽度恒等于模块数（含静区），扫码行为与替换前一致。
 */
import { encode } from "uqr";

/** 白底 + 黑前景：静区/亮模块走背景色，暗模块走前景色。 */
const STYLE = "\x1b[47m\x1b[30m";
const RESET = "\x1b[0m";

/** 纠错级别 M（15% 容错）与旧 qrcode 默认值一致；静区 1 模块同旧输出。 */
const ECC = "M" as const;
const BORDER = 1;

/** 单个字符格：上/下两个模块的明暗组合映射到 half-block 字符。 */
function cellChar(upper: boolean, lower: boolean): string {
    if (upper && lower) {
        return "█";
    }
    if (upper) {
        return "▀";
    }
    if (lower) {
        return "▄";
    }
    return " ";
}

/**
 * 渲染终端二维码（ANSI 着色，返回值不含结尾换行）。
 * 每个字符行承载矩阵的两行：`▀` 上半暗、`▄` 下半暗、`█` 全暗、空格全亮；
 * 矩阵高度为奇数时最后一行的下半按静区（亮）补齐。
 * @throws uqr 编码失败（如 URL 超出二维码容量）时抛出，由调用方决定吞掉与否
 */
export function renderQrAnsi(text: string): string {
    const { data } = encode(text, { ecc: ECC, border: BORDER });
    const cols = data[0]?.length ?? 0;
    const lines: string[] = [];
    for (let y = 0; y < data.length; y += 2) {
        const top = data[y] ?? [];
        const bottom = data[y + 1] ?? [];
        let line = "";
        for (let x = 0; x < cols; x++) {
            line += cellChar(top[x] ?? false, bottom[x] ?? false);
        }
        lines.push(STYLE + line + RESET);
    }
    return lines.join("\n");
}
