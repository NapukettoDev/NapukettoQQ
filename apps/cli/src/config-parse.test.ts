/**
 * config-parse.test.ts：主配置手写校验器单测（占位 QQ 号护栏；[log] 段接入）。
 *
 * 覆盖 accounts.qq 校验：纯数字 5-11 位、拒绝模板占位值（123456 / 654321）、
 * 拒绝非数字 / 超长 / 过短。dataDir 显式传入，避免 resolveDataRoot 触发文件系统探测。
 * [log] 段（2026-10-25）：经 kernel parseLogConfig 严格校验入 CliConfig.log，
 * 未配置段时无 log 字段；format 未配置时剔除 undefined 键（toml 回写安全）。
 */
import { describe, expect, it } from "vitest";
import { parseCliConfig } from "./config-parse.js";

/** 构造最小合法主配置（含单个账号，qq 由调用方指定）。 */
function configWithQq(qq: string): Record<string, unknown> {
    return {
        dataDir: ".napuketto",
        autoRestart: true,
        restartDelayMs: 2000,
        accounts: [{ qq }],
    };
}

describe("parseCliConfig accounts.qq 校验", () => {
    it("接受 5 位纯数字 QQ 号", () => {
        const config = parseCliConfig(configWithQq("10000"));
        expect(config.accounts[0]?.qq).toBe("10000");
    });

    it("接受 11 位纯数字 QQ 号", () => {
        const config = parseCliConfig(configWithQq("12345678901"));
        expect(config.accounts[0]?.qq).toBe("12345678901");
    });

    it("拒绝占位值 123456", () => {
        expect(() => parseCliConfig(configWithQq("123456"))).toThrow(/占位值/);
    });

    it("拒绝占位值 654321", () => {
        expect(() => parseCliConfig(configWithQq("654321"))).toThrow(/占位值/);
    });

    it("拒绝非纯数字", () => {
        expect(() => parseCliConfig(configWithQq("12a456"))).toThrow(/纯数字/);
    });

    it("拒绝超长（12 位）", () => {
        expect(() => parseCliConfig(configWithQq("123456789012"))).toThrow(/5-11 位/);
    });

    it("拒绝过短（4 位）", () => {
        expect(() => parseCliConfig(configWithQq("1234"))).toThrow(/5-11 位/);
    });
});

describe("parseCliConfig [log] 段", () => {
    it("未配置段时无 log 字段（缺省行为）", () => {
        const config = parseCliConfig(configWithQq("10000"));
        expect("log" in config).toBe(false);
    });

    it("合法段解析入 log（format 未配置时键被剔除，toml 回写安全）", () => {
        const config = parseCliConfig({
            ...configWithQq("10000"),
            log: { level: "warn", banner: false },
        });
        expect(config.log?.level).toBe("warn");
        expect(config.log?.banner).toBe(false);
        expect("format" in (config.log ?? {})).toBe(false);
    });

    it("非法段值报错（kernel parseLogConfig 校验透传）", () => {
        expect(() =>
            parseCliConfig({ ...configWithQq("10000"), log: { level: "verbose" } }),
        ).toThrow(/log\.level/);
        expect(() =>
            parseCliConfig({ ...configWithQq("10000"), log: { levels: { nope: "debug" } } }),
        ).toThrow(/未知模块/);
    });
});
