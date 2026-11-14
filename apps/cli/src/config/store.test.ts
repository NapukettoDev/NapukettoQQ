/**
 * store.test.ts：CliConfigStore 读写与模板兜底单测。
 *
 * 覆盖（补充 source.test.ts 之外的 store 领域）：defaultCliConfig 形状、
 * store 路径决议（NAPKETTO_CONFIG 显式）、save/load 往返、配置缺失时
 * ensureConfigTemplate 自动生成模板（生成后再 load 报占位值 ConfigError）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { ConfigError } from "@napuketto/kernel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../logger.js", () => ({ logger: mocks.logger }));

import {
    CliConfigStore,
    defaultCliConfig,
    loadCliConfigWithSource,
    resolveCliConfigSource,
} from "./store.js";

let tmp = "";

beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "napuketto-store-test-"));
    delete process.env["NAPKETTO_CONFIG_JSON"];
    delete process.env["NAPKETTO_CONFIG"];
    delete process.env["NAPKETTO_DATA"];
    for (const fn of Object.values(mocks.logger)) {
        fn.mockReset();
    }
});

afterEach(() => {
    delete process.env["NAPKETTO_CONFIG_JSON"];
    delete process.env["NAPKETTO_CONFIG"];
    delete process.env["NAPKETTO_DATA"];
    if (tmp !== "") {
        rmSync(tmp, { recursive: true, force: true });
        tmp = "";
    }
});

/** 合法单账号 TOML 文本。 */
function validToml(qq: string): string {
    return `autoRestart = false\nrestartDelayMs = 4000\n[[accounts]]\nqq = "${qq}"\n`;
}

describe("defaultCliConfig", () => {
    it("dataDir = 当前数据根；autoRestart/restartDelayMs 缺省开启；accounts 为空数组", () => {
        expect(defaultCliConfig(tmp)).toEqual({
            dataDir: tmp,
            autoRestart: true,
            restartDelayMs: 2000,
            nativeMediaPatch: true,
            accounts: [],
        });
    });
});

describe("CliConfigStore", () => {
    it("NAPKETTO_CONFIG 显式指定 → store.path 取该路径", () => {
        const configPath = join(tmp, "napuketto.toml");
        process.env["NAPKETTO_CONFIG"] = configPath;
        const store = new CliConfigStore(tmp);
        expect(store.path).toBe(configPath);
    });

    it("save → load 往返保持账号与全局字段", async () => {
        const configPath = join(tmp, "napuketto.toml");
        process.env["NAPKETTO_CONFIG"] = configPath;
        const store = new CliConfigStore(tmp);
        await store.save({
            dataDir: tmp,
            autoRestart: false,
            restartDelayMs: 4000,
            nativeMediaPatch: false,
            accounts: [{ qq: "10086" }],
        });
        const loaded = await store.load();
        expect(loaded.autoRestart).toBe(false);
        expect(loaded.restartDelayMs).toBe(4000);
        expect(loaded.accounts).toHaveLength(1);
        expect(loaded.accounts[0]?.qq).toBe("10086");
        expect(existsSync(configPath)).toBe(true);
    });

    it("配置缺失 → load 报 ConfigError 且不落盘（缺省 defaults 无账号过不了校验；模板兜底在上游 ensureConfigTemplate）", async () => {
        const configPath = join(tmp, "napuketto.toml");
        process.env["NAPKETTO_CONFIG"] = configPath;
        const store = new CliConfigStore(tmp);
        // save(defaults) 先 parse 再写盘：defaults（accounts 为空）校验失败 → 无文件产生
        await expect(store.load()).rejects.toThrow(ConfigError);
        await expect(store.load()).rejects.toThrow(/配置文件校验失败/);
        expect(existsSync(configPath)).toBe(false);
    });

    it("load 合法文件 → 解析出 accounts 与全局字段", async () => {
        const configPath = join(tmp, "napuketto.toml");
        process.env["NAPKETTO_CONFIG"] = configPath;
        writeFileSync(configPath, validToml("10001"), "utf8");
        const store = new CliConfigStore(tmp);
        const config = await store.load();
        expect(config.accounts[0]?.qq).toBe("10001");
        expect(config.autoRestart).toBe(false);
        // 已存在时不重复生成模板（无「已生成」日志）
        expect(mocks.logger.info).not.toHaveBeenCalled();
    });
});

describe("resolveCliConfigSource", () => {
    it("内联非空 → inline 来源并带回原文（不读文件）", () => {
        process.env["NAPKETTO_CONFIG_JSON"] = '{"accounts":[{"qq":"10086"}]}';
        const resolved = resolveCliConfigSource({ dataDir: tmp });
        if (resolved.source !== "inline") {
            expect.unreachable("内联生效时应返回 inline 来源");
        }
        expect(resolved.text).toBe('{"accounts":[{"qq":"10086"}]}');
    });

    it("无内联 → file 来源带回路径与数据根", () => {
        const configPath = join(tmp, "napuketto.toml");
        process.env["NAPKETTO_CONFIG"] = configPath;
        const resolved = resolveCliConfigSource({ dataDir: tmp });
        expect(resolved.source).toBe("file");
        if (resolved.source === "file") {
            expect(resolved.path).toBe(configPath);
            expect(resolved.dataRoot).toBe(tmp);
        }
    });

    it("opts 缺省调用（无 dataDir）→ file 来源（env/项目根决议）", () => {
        const configPath = join(tmp, "explicit.toml");
        process.env["NAPKETTO_CONFIG"] = configPath;
        const resolved = resolveCliConfigSource();
        expect(resolved.source).toBe("file");
        if (resolved.source === "file") {
            expect(resolved.path).toBe(configPath);
        }
    });
});

describe("loadCliConfigWithSource 文件形态补充", () => {
    it("文件缺失 → ensureConfigTemplate 生成模板（落盘）再解析报 ConfigError（占位号在 cause）", async () => {
        const configPath = join(tmp, "napuketto.toml");
        process.env["NAPKETTO_CONFIG"] = configPath;
        await expect(loadCliConfigWithSource({ dataDir: tmp })).rejects.toThrow(/配置文件校验失败/);
        // 模板已生成（首次启动自动落盘），内容含占位账号与引导注释
        expect(existsSync(configPath)).toBe(true);
        const generated = readFileSync(configPath, "utf8");
        expect(generated).toContain('qq = "123456"');
        expect(generated).toContain("NapukettoQQ 全局配置文件");
        expect(mocks.logger.info).toHaveBeenCalledWith(
            { path: configPath },
            "配置文件不存在，已生成默认模板（请编辑 accounts 段填入 QQ 号）",
        );
    });
});
