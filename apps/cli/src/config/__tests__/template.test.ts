/**
 * template.test.ts：配置模板段落归属（注释示例不得串段）。
 *
 * 2026-08-08 结构拍板：协议段嵌在账号内。KuroBot 的 join/leave/death 模板
 * 属于 [accounts.kurobot]；本次回归断言它们不再误挂在 [accounts.milky] 段尾。
 */
import { describe, expect, it } from "vitest";

import { configTemplate } from "../template.js";

/** 模板中两个协议注释段的文本（kurobot 在前，milky 在后）。 */
function protocolBlocks(): { kurobot: string; milky: string } {
    const text = configTemplate();
    const kurobotStart = text.indexOf("# [accounts.kurobot]");
    const milkyStart = text.indexOf("# [accounts.milky]");
    expect(kurobotStart).toBeGreaterThan(-1);
    expect(milkyStart).toBeGreaterThan(kurobotStart);
    return {
        kurobot: text.slice(kurobotStart, milkyStart),
        milky: text.slice(milkyStart),
    };
}

describe("configTemplate 协议段注释归属", () => {
    it("join / leave / death 模板都在 [accounts.kurobot] 段内", () => {
        const { kurobot } = protocolBlocks();
        expect(kurobot).toContain("joinTemplate");
        expect(kurobot).toContain("leaveTemplate");
        expect(kurobot).toContain("deathTemplate");
    });

    it("[accounts.milky] 段不再残留 kurobot 模板注释", () => {
        const { milky } = protocolBlocks();
        expect(milky).not.toContain("leaveTemplate");
        expect(milky).not.toContain("deathTemplate");
    });
});
