/**
 * logger.test.ts：cli 进程日志配置与渲染决策单测（2026-10-25 日志可配置化）。
 *
 * 覆盖：resolveCliLogConfig（toml [log] 解析 / env 覆盖优先 / 配置缺失与非法
 * 回退 / 模块内缓存）、effectiveConsoleFormat / effectiveConsoleEnv 的 TTY
 * 决策（显式配置优先，缺省按 TTY：pretty+色 / single-line 无色）、
 * LazyCliLogger 懒构造（json 逐行输出契约 + 级别过滤 + [log.file] 落盘）。
 *
 * 模块带缓存（cachedConfig / cachedDataRoot）——每用例 resetModules 后重导。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import type { LogConfig } from "@napuketto/kernel";
import { afterEach, describe, expect, it, vi } from "vitest";

type CliLoggerModule = typeof import("./logger.js");

const ENV_KEYS = [
    "NAPKETTO_CONFIG",
    "NAPKETTO_CONFIG_JSON",
    "NAPKETTO_DATA",
    "NAPUKETTO_LOG_LEVEL",
    "NAPKETTO_LOG_LEVEL",
    "NAPUKETTO_LOG_FORMAT",
    "NAPUKETTO_LOG_COLORIZE",
    "NAPUKETTO_NO_BANNER",
];

let tmp = "";

function freshDir(): string {
    tmp = mkdtempSync(join(tmpdir(), "napuketto-cli-logger-test-"));
    return tmp;
}

function setEnv(key: string, value: string | undefined): void {
    if (value === undefined) {
        delete process.env[key];
    } else {
        process.env[key] = value;
    }
}

/** 设 env 后重载 cli logger 模块（新缓存实例）。 */
async function freshCliLogger(env: Record<string, string | undefined>): Promise<CliLoggerModule> {
    for (const key of ENV_KEYS) {
        setEnv(key, env[key]);
    }
    vi.resetModules();
    return await import("./logger.js");
}

/** 写全局配置文件，返回其路径。 */
function writeToml(text: string): string {
    const configPath = join(freshDir(), "napuketto.toml");
    writeFileSync(configPath, text, "utf8");
    return configPath;
}

afterEach(() => {
    for (const key of ENV_KEYS) {
        delete process.env[key];
    }
    if (tmp !== "") {
        rmSync(tmp, { recursive: true, force: true });
        tmp = "";
    }
    vi.restoreAllMocks();
});

describe("resolveCliLogConfig", () => {
    it("toml [log] 段解析（level/format/timestamp/banner）", async () => {
        const configPath = writeToml(
            [
                "[log]",
                'level = "warn"',
                'format = "single-line"',
                'timestamp = "iso8601"',
                "banner = false",
                "",
            ].join("\n"),
        );
        const mod = await freshCliLogger({ NAPKETTO_CONFIG: configPath });
        const cfg = mod.resolveCliLogConfig();
        expect(cfg.level).toBe("warn");
        expect(cfg.format).toBe("single-line");
        expect(cfg.timestamp).toBe("iso8601");
        expect(cfg.banner).toBe(false);
    });

    it("内联配置生效：[log] 段取自 NAPKETTO_CONFIG_JSON（不读 toml）", async () => {
        const configPath = join(freshDir(), "不存在.toml");
        const mod = await freshCliLogger({
            NAPKETTO_CONFIG_JSON: JSON.stringify({ log: { level: "debug", banner: false } }),
            NAPKETTO_CONFIG: configPath,
        });
        const cfg = mod.resolveCliLogConfig();
        expect(cfg.level).toBe("debug");
        expect(cfg.banner).toBe(false);
        expect(existsSync(configPath)).toBe(false);
    });

    it("env 覆盖 toml（NAPUKETTO_LOG_LEVEL / LOG_FORMAT / NO_BANNER）", async () => {
        const configPath = writeToml('[log]\nlevel = "warn"\nbanner = true\n');
        const mod = await freshCliLogger({
            NAPKETTO_CONFIG: configPath,
            NAPUKETTO_LOG_LEVEL: "debug",
            NAPUKETTO_LOG_FORMAT: "json",
            NAPUKETTO_NO_BANNER: "1",
        });
        const cfg = mod.resolveCliLogConfig();
        expect(cfg.level).toBe("debug");
        expect(cfg.format).toBe("json");
        expect(cfg.banner).toBe(false);
    });

    it("配置缺失：回退缺省（info / banner true / format 自动）", async () => {
        const mod = await freshCliLogger({ NAPKETTO_CONFIG: join(freshDir(), "不存在.toml") });
        const cfg = mod.resolveCliLogConfig();
        expect(cfg.level).toBe("info");
        expect(cfg.format).toBeUndefined();
        expect(cfg.banner).toBe(true);
    });

    it("[log] 段非法：env 仍生效，缺省兜底不阻塞", async () => {
        const configPath = writeToml('[log]\nlevel = "verbose"\n');
        const mod = await freshCliLogger({
            NAPKETTO_CONFIG: configPath,
            NAPUKETTO_LOG_LEVEL: "warn",
        });
        const cfg = mod.resolveCliLogConfig();
        expect(cfg.level).toBe("warn");
    });

    it("同一模块实例内缓存（二次调用返回同对象）", async () => {
        const mod = await freshCliLogger({ NAPKETTO_CONFIG: join(freshDir(), "不存在.toml") });
        expect(mod.resolveCliLogConfig()).toBe(mod.resolveCliLogConfig());
    });
});

describe("effectiveConsoleFormat / effectiveConsoleEnv", () => {
    const baseConfig: LogConfig = {
        level: "info",
        banner: true,
        timestamp: "local",
        unboundReceive: true,
        levels: {},
    };

    it("format 显式配置：不随 TTY 变化", async () => {
        const mod = await freshCliLogger({});
        const cfg: LogConfig = { ...baseConfig, format: "json" };
        expect(mod.effectiveConsoleFormat(cfg)).toBe("json");
    });

    it("TTY：缺省 pretty + 着色", async () => {
        const mod = await freshCliLogger({});
        const tty = { value: true, configurable: true };
        Object.defineProperty(process.stdout, "isTTY", tty);
        expect(mod.effectiveConsoleFormat(baseConfig)).toBe("pretty");
        expect(mod.effectiveConsoleEnv(baseConfig)).toEqual({
            NAPUKETTO_LOG_FORMAT: "pretty",
            NAPUKETTO_LOG_COLORIZE: "1",
        });
    });

    it("管道：缺省 single-line + 不着色（嵌入式宿主契约）", async () => {
        const mod = await freshCliLogger({});
        Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
        expect(mod.effectiveConsoleFormat(baseConfig)).toBe("single-line");
        expect(mod.effectiveConsoleEnv(baseConfig)).toEqual({
            NAPUKETTO_LOG_FORMAT: "single-line",
            NAPUKETTO_LOG_COLORIZE: "0",
        });
    });

    it("colorize 显式 false：pretty 也不着色", async () => {
        const mod = await freshCliLogger({});
        Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
        const cfg: LogConfig = { ...baseConfig, colorize: false };
        expect(mod.effectiveConsoleEnv(cfg)).toEqual({
            NAPUKETTO_LOG_FORMAT: "pretty",
            NAPUKETTO_LOG_COLORIZE: "0",
        });
    });
});

describe("LazyCliLogger 懒构造", () => {
    it("json 格式：输出行可 JSON.parse，module=cli，debug 级别透传", async () => {
        const dir = freshDir();
        const mod = await freshCliLogger({
            NAPKETTO_CONFIG: join(dir, "不存在.toml"),
            NAPKETTO_DATA: dir,
            NAPUKETTO_LOG_FORMAT: "json",
            NAPUKETTO_LOG_LEVEL: "debug",
        });
        const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
        mod.logger.debug({ seq: 7 }, "调试行");
        const written = writeSpy.mock.calls.map((c) => String(c[0])).join("");
        const line = written.trimEnd().split("\n").at(-1);
        const parsed = JSON.parse(line ?? "") as Record<string, unknown>;
        expect(parsed["module"]).toBe("cli");
        expect(parsed["level"]).toBe("debug");
        expect(parsed["msg"]).toBe("调试行");
        expect(parsed["seq"]).toBe(7);
    });

    it("缺省 info 级别：debug 被过滤不输出", async () => {
        const dir = freshDir();
        const mod = await freshCliLogger({
            NAPKETTO_CONFIG: join(dir, "不存在.toml"),
            NAPKETTO_DATA: dir,
            NAPUKETTO_LOG_FORMAT: "json",
        });
        const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
        mod.logger.debug({}, "不应出现");
        mod.logger.warn({}, "应出现");
        const written = writeSpy.mock.calls.map((c) => String(c[0])).join("");
        expect(written).not.toContain("不应出现");
        expect(written).toContain("应出现");
    });

    it("[log.file] 配置：文件 sink 落盘数据根", async () => {
        const dir = freshDir();
        const configPath = writeToml('[log.file]\npath = "custom-debug.log"\n');
        const mod = await freshCliLogger({
            NAPKETTO_CONFIG: configPath,
            NAPKETTO_DATA: dir,
            NAPUKETTO_LOG_LEVEL: "debug",
        });
        const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
        mod.logger.debug({ mark: "file-sink" }, "文件行");
        const logPath = join(dir, "custom-debug.log");
        expect(existsSync(logPath)).toBe(true);
        const text = readFileSync(logPath, "utf8");
        expect(text).toContain("file-sink");
        writeSpy.mockRestore();
    });
});
