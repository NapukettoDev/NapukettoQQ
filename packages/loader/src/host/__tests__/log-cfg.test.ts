/**
 * log-cfg.test.ts：自建宿主日志配置解析单测（2026-10-25 日志可配置化）。
 *
 * 覆盖：kernel 无 parseLogConfig（老版本）回退缺省、配置读取失败回退缺省、
 * 正常路径（parseToml → parseLogConfig 透传 [log] 段）、resolveLogFilePath
 * 的相对路径基准优先级（NAPUTO_DATA_ROOT > NAPKETTO_DATA > CFG_DIR 父目录）
 * 与绝对路径直传。env 是模块加载期快照——每用例 resetModules 后重导。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KernelLike } from "../types.js";

type LogCfgModule = typeof import("../log-cfg.js");

/** 本用例涉及的 env 键（用例内显式置空，隔离宿主环境残留）。 */
const ENV_KEYS = ["NAPKETTO_CONFIG", "NAPKETTO_DATA", "NAPUTO_CFG_DIR", "NAPUTO_DATA_ROOT"];

let tmp = "";

function freshDir(): string {
    tmp = mkdtempSync(join(tmpdir(), "napuketto-logcfg-test-"));
    return tmp;
}

/** 设定 env 快照后重载 log-cfg 模块。 */
async function freshLogCfg(env: Record<string, string | undefined>): Promise<LogCfgModule> {
    for (const key of ENV_KEYS) {
        setEnv(key, env[key]);
    }
    vi.resetModules();
    return await import("../log-cfg.js");
}

function setEnv(key: string, value: string | undefined): void {
    if (value === undefined) {
        delete process.env[key];
    } else {
        process.env[key] = value;
    }
}

afterEach(() => {
    for (const key of ENV_KEYS) {
        delete process.env[key];
    }
    if (tmp !== "") {
        rmSync(tmp, { recursive: true, force: true });
        tmp = "";
    }
});

/** kernel 桩：parseToml/parseLogConfig 可注入行为。 */
function stubKernel(
    parseToml: (raw: string) => Record<string, unknown>,
    parseLogConfig?: (section: unknown, env: unknown) => unknown,
): KernelLike {
    return {
        parseToml,
        ...(parseLogConfig !== undefined ? { parseLogConfig } : {}),
    } as unknown as KernelLike;
}

describe("resolveLoaderLogConfig", () => {
    it("kernel 无 parseLogConfig（老版本）：回退缺省", async () => {
        const mod = await freshLogCfg({ NAPKETTO_CONFIG: join(freshDir(), "none.toml") });
        const cfg = mod.resolveLoaderLogConfig(stubKernel(() => ({})));
        expect(cfg.level).toBe("info");
        expect(cfg.banner).toBe(true);
        expect(cfg.unboundReceive).toBe(true);
    });

    it("配置文件读取失败：回退缺省，不阻塞引导", async () => {
        const mod = await freshLogCfg({ NAPKETTO_CONFIG: join(freshDir(), "不存在.toml") });
        const parseLogConfig = vi.fn();
        const cfg = mod.resolveLoaderLogConfig(stubKernel(() => ({}), parseLogConfig));
        expect(cfg.level).toBe("info");
        expect(parseLogConfig).not.toHaveBeenCalled();
    });

    it("正常路径：[log] 段经 parseToml → parseLogConfig 透传", async () => {
        const dir = freshDir();
        const configPath = join(dir, "napuketto.toml");
        writeFileSync(configPath, '[log]\nlevel = "debug"\n', "utf8");
        const mod = await freshLogCfg({ NAPKETTO_CONFIG: configPath });
        const parseLogConfig = vi.fn((_section: unknown) => ({
            level: "debug",
            banner: false,
            timestamp: "iso8601",
            unboundReceive: true,
            levels: {},
        }));
        const kernel = stubKernel(
            () => ({ log: { level: "debug" } }),
            (section) => parseLogConfig(section),
        );
        const cfg = mod.resolveLoaderLogConfig(kernel);
        expect(cfg.level).toBe("debug");
        expect(cfg.banner).toBe(false);
        expect(cfg.timestamp).toBe("iso8601");
        expect(parseLogConfig).toHaveBeenCalledWith({ level: "debug" });
    });

    it("NAPKETTO_CONFIG 未设时按 CFG_DIR 兜底 napuketto.toml", async () => {
        const dir = freshDir();
        writeFileSync(join(dir, "napuketto.toml"), '[log]\nlevel = "warn"\n', "utf8");
        const mod = await freshLogCfg({ NAPUTO_CFG_DIR: dir });
        const parseLogConfig = vi.fn((_section: unknown) => ({
            level: "warn",
            banner: true,
            unboundReceive: true,
            levels: {},
        }));
        const kernel = stubKernel(
            () => ({ log: { level: "warn" } }),
            (section) => parseLogConfig(section),
        );
        const cfg = mod.resolveLoaderLogConfig(kernel);
        expect(cfg.level).toBe("warn");
    });
});

describe("resolveLogFilePath", () => {
    it("绝对路径直传", async () => {
        const mod = await freshLogCfg({ NAPUTO_DATA_ROOT: freshDir() });
        expect(mod.resolveLogFilePath("D:\\logs\\a.log")).toBe("D:\\logs\\a.log");
        expect(mod.resolveLogFilePath("/var/log/a.log")).toBe("/var/log/a.log");
    });

    it("相对路径基准：NAPUTO_DATA_ROOT 优先", async () => {
        const mod = await freshLogCfg({
            NAPUTO_DATA_ROOT: join(freshDir(), "root-a"),
            NAPKETTO_DATA: join(tmp, "root-b"),
            NAPUTO_CFG_DIR: join(tmp, "root-c"),
        });
        const path = mod.resolveLogFilePath("logs/x.log");
        expect(path.startsWith(join(tmp, "root-a"))).toBe(true);
        expect(isAbsolute(path)).toBe(true);
    });

    it("相对路径基准：次选 NAPKETTO_DATA", async () => {
        const mod = await freshLogCfg({
            NAPKETTO_DATA: join(freshDir(), "root-b"),
            NAPUTO_CFG_DIR: join(tmp, "root-c"),
        });
        expect(mod.resolveLogFilePath("x.log")).toBe(join(tmp, "root-b", "x.log"));
    });

    it("相对路径基准：再次选 CFG_DIR 父目录（账号目录 → 数据根）", async () => {
        const mod = await freshLogCfg({ NAPUTO_CFG_DIR: join(freshDir(), "root-c") });
        expect(mod.resolveLogFilePath("x.log")).toBe(join(tmp, "root-c", "..", "x.log"));
    });

    it("全部未注入：cwd 基准", async () => {
        const mod = await freshLogCfg({});
        expect(mod.resolveLogFilePath("x.log")).toBe("x.log");
    });
});
