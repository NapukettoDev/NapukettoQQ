/**
 * parseLogConfig 测试（[log] 段 + 环境变量覆盖，2026-10-25 日志可配置化）。
 *
 * 覆盖：缺省值 / toml 各键解析 / 非法值报错 / env 覆盖优先级（含
 * NAPKETTO_LOG_LEVEL 旧拼写兼容与非法 env 忽略）/ file.level 跟随与显式保留。
 */
import { describe, expect, it } from "vitest";
import { parseLogConfig } from "../log-config.js";

describe("parseLogConfig 缺省", () => {
    it("section 缺失时全缺省", () => {
        expect(parseLogConfig(undefined)).toEqual({
            level: "info",
            banner: true,
            timestamp: "local",
            unboundReceive: true,
            levels: {},
        });
    });

    it("空对象段等于缺省", () => {
        expect(parseLogConfig({})).toEqual(parseLogConfig(undefined));
    });
});

describe("parseLogConfig toml 解析", () => {
    it("各键合法值生效", () => {
        const cfg = parseLogConfig({
            level: "warn",
            format: "json",
            banner: false,
            timestamp: "iso8601",
            unboundReceive: false,
            levels: { loader: "debug", ob11: "trace" },
            file: { path: "logs/x.log", level: "debug" },
        });
        expect(cfg.level).toBe("warn");
        expect(cfg.format).toBe("json");
        expect(cfg.banner).toBe(false);
        expect(cfg.timestamp).toBe("iso8601");
        expect(cfg.unboundReceive).toBe(false);
        expect(cfg.levels).toEqual({ loader: "debug", ob11: "trace" });
        expect(cfg.file).toEqual({ path: "logs/x.log", level: "debug" });
    });

    it("file.level 缺省跟随全局 level", () => {
        const cfg = parseLogConfig({ level: "warn", file: { path: "x.log" } });
        expect(cfg.file?.level).toBe("warn");
    });

    it("非法 level/format/timestamp/banner/unboundReceive 报错", () => {
        expect(() => parseLogConfig({ level: "verbose" })).toThrow(/log\.level/);
        expect(() => parseLogConfig({ format: "ndjson" })).toThrow(/log\.format/);
        expect(() => parseLogConfig({ timestamp: "utc" })).toThrow(/log\.timestamp/);
        expect(() => parseLogConfig({ banner: "yes" })).toThrow(/log\.banner/);
        expect(() => parseLogConfig({ unboundReceive: 1 })).toThrow(/log\.unboundReceive/);
    });

    it("levels 未知模块报错并列出合法模块", () => {
        expect(() => parseLogConfig({ levels: { ob: "debug" } })).toThrow(/未知模块 "ob"/);
    });

    it("file 缺 path 报错", () => {
        expect(() => parseLogConfig({ file: { level: "debug" } })).toThrow(/log\.file\.path/);
    });
});

describe("parseLogConfig env 覆盖", () => {
    it("NAPUKETTO_LOG_LEVEL 覆盖 toml level", () => {
        const cfg = parseLogConfig({ level: "info" }, { NAPUKETTO_LOG_LEVEL: "warn" });
        expect(cfg.level).toBe("warn");
    });

    it("旧拼写 NAPKETTO_LOG_LEVEL 兼容，NAPUKETTO_ 优先", () => {
        expect(parseLogConfig({}, { NAPKETTO_LOG_LEVEL: "warn" }).level).toBe("warn");
        const both = parseLogConfig(
            {},
            { NAPKETTO_LOG_LEVEL: "error", NAPUKETTO_LOG_LEVEL: "debug" },
        );
        expect(both.level).toBe("debug");
    });

    it("非法 env 值忽略（不报错不生效）", () => {
        const cfg = parseLogConfig(
            { level: "info" },
            {
                NAPUKETTO_LOG_LEVEL: "verbose",
                NAPUKETTO_LOG_FORMAT: "yaml",
                NAPUKETTO_NO_BANNER: "maybe",
            },
        );
        expect(cfg.level).toBe("info");
        expect(cfg.format).toBeUndefined();
        expect(cfg.banner).toBe(true);
    });

    it("NAPUKETTO_LOG_FORMAT / NAPUKETTO_NO_BANNER / NAPUKETTO_LOG_COLORIZE", () => {
        const cfg = parseLogConfig(
            { format: "pretty" },
            {
                NAPUKETTO_LOG_FORMAT: "single-line",
                NAPUKETTO_NO_BANNER: "true",
                NAPUKETTO_LOG_COLORIZE: "0",
            },
        );
        expect(cfg.format).toBe("single-line");
        expect(cfg.banner).toBe(false);
        expect(cfg.colorize).toBe(false);
    });

    it("env 全局级别不顶掉 toml 显式 file.level；缺省 file.level 跟随", () => {
        const explicit = parseLogConfig(
            { level: "info", file: { path: "x.log", level: "debug" } },
            { NAPUKETTO_LOG_LEVEL: "warn" },
        );
        expect(explicit.file?.level).toBe("debug");
        const implicit = parseLogConfig(
            { level: "info", file: { path: "x.log" } },
            { NAPUKETTO_LOG_LEVEL: "warn" },
        );
        expect(implicit.file?.level).toBe("warn");
    });
});
