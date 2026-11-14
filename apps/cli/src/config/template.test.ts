/**
 * template.test.ts：TOML 配置模板内容断言。
 *
 * 覆盖：模板是合法 TOML（parseToml 可解析）、结构段齐全（accounts / onebot11 /
 * satori / kurobot / milky）、占位 QQ 号存在（账号必填）、默认值字段
 * （autoRestart / restartDelayMs）、OB11 网络实例段（httpServers / wsServers）。
 */

import { parseToml } from "@napuketto/kernel";
import { describe, expect, it } from "vitest";
import { configTemplate } from "./template.js";

describe("configTemplate 模板内容", () => {
    it("返回大段文本，首行为注释横幅（init 落盘时以模板 + \\n 写入）", () => {
        const template = configTemplate();
        expect(template.length).toBeGreaterThan(1000);
        expect(template.endsWith("\n")).toBe(true);
        expect(template.startsWith("# ===")).toBe(true);
    });

    it("是合法 TOML（parseToml 可解析出全局字段与 accounts 表数组）", () => {
        const parsed = parseToml(configTemplate()) as {
            autoRestart?: unknown;
            restartDelayMs?: unknown;
            accounts?: Record<string, unknown>[];
        };
        expect(parsed.autoRestart).toBe(true);
        expect(parsed.restartDelayMs).toBe(2000);
        expect(parsed["nativeMediaPatch"]).toBe(true);
        expect(parsed.accounts).toHaveLength(1);
        expect(parsed.accounts?.[0]?.["qq"]).toBe("123456");
        expect(parsed.accounts?.[0]?.["enabled"]).toBe(true);
    });

    it("包含全部协议段示例（onebot11 / satori / kurobot / milky）", () => {
        const template = configTemplate();
        expect(template).toContain("[accounts.onebot11]");
        expect(template).toContain("[[accounts.onebot11.httpServers]]");
        expect(template).toContain("[[accounts.onebot11.wsServers]]");
        expect(template).toContain("[accounts.satori]");
        expect(template).toContain("[accounts.kurobot]");
        expect(template).toContain("[accounts.milky]");
    });

    it("账号段含占位 qq 与启用注释（引导用户替换）", () => {
        const template = configTemplate();
        expect(template).toContain('qq = "123456"');
        expect(template).toContain("必须替换为你的 QQ 号");
        expect(template).toContain("enabled = true");
    });

    it("OB11 网络实例缺省端口与鉴权注释齐全", () => {
        const template = configTemplate();
        expect(template).toContain("port = 3000");
        expect(template).toContain("port = 3001");
        expect(template).toContain("heartbeatInterval");
        expect(template).toContain("messagePostFormat = ");
    });

    it("第二个账号示例（Satori）保持注释形态（不生效）", () => {
        const template = configTemplate();
        expect(template).toContain("# [[accounts]]");
        expect(template).toContain("# [accounts.satori]");
    });

    it("日志段说明覆盖环境变量覆盖与 [log] 配置", () => {
        const template = configTemplate();
        expect(template).toContain("NAPUKETTO_LOG_LEVEL");
        expect(template).toContain("NAPUKETTO_NO_BANNER");
        expect(template).toContain("[log]");
    });

    it("重复调用返回相同内容（纯函数）", () => {
        expect(configTemplate()).toBe(configTemplate());
    });
});
