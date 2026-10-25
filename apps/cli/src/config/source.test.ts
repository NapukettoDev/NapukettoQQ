/**
 * source.test.ts：内联配置（NAPKETTO_CONFIG_JSON）与配置来源优先级单测
 * （2026-10-25 嵌入式契约）。
 *
 * 覆盖：读取边角（未设置 / 空串 / 纯空白回退文件；键名精确访问）、内联校验错误
 * 一概 ConfigError 且文案不含任何 toml 文件路径、加载优先级矩阵（内联 > 文件，
 * 内联生效零文件落盘）、文件形态行为不回退。logger 换桩避免真实 stdout 噪音。
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { ConfigError } from "@napuketto/kernel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../logger.js", () => ({ logger: mocks.logger }));

import { parseInlineConfig, readInlineConfigText } from "./inline.js";
import { loadCliConfigWithSource } from "./store.js";

/** 合法内联文档（单账号，qq 由调用方指定）。 */
function inlineDoc(qq: string): Record<string, unknown> {
    return {
        autoRestart: true,
        restartDelayMs: 2000,
        accounts: [{ qq }],
    };
}

let tmp = "";

beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "napuketto-inline-test-"));
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

describe("readInlineConfigText 读取边角", () => {
    it("未设置 → undefined", () => {
        expect(readInlineConfigText()).toBeUndefined();
    });

    it("空串 / 纯空白 → undefined（回退文件形态）", () => {
        for (const value of ["", "   ", "\n\t "]) {
            process.env["NAPKETTO_CONFIG_JSON"] = value;
            expect(readInlineConfigText()).toBeUndefined();
        }
    });

    it("非空文本原样返回", () => {
        process.env["NAPKETTO_CONFIG_JSON"] = '  {"accounts":[]}  ';
        expect(readInlineConfigText()).toBe('  {"accounts":[]}  ');
    });
});

describe("parseInlineConfig 校验", () => {
    it("合法文档 → CliConfig", () => {
        const config = parseInlineConfig(JSON.stringify(inlineDoc("10086")));
        expect(config.accounts[0]?.qq).toBe("10086");
    });

    it("占位 qq → ConfigError，文案不含 toml 路径字样", () => {
        process.env["NAPKETTO_CONFIG"] = join(tmp, "其他.toml");
        try {
            parseInlineConfig(JSON.stringify(inlineDoc("123456")));
            expect.unreachable("应抛出 ConfigError");
        } catch (err) {
            expect(err).toBeInstanceOf(ConfigError);
            const { message } = err as Error;
            expect(message).toContain("占位值");
            expect(message).not.toMatch(/\.toml/);
            expect(message).not.toContain(join(tmp, "其他.toml"));
        }
    });

    it("JSON 解析失败 → ConfigError（内联 JSON 解析失败，无文件路径）", () => {
        expect(() => parseInlineConfig("{not-json")).toThrow(ConfigError);
        try {
            parseInlineConfig("{not-json");
        } catch (err) {
            expect((err as Error).message).toContain("内联配置 JSON 解析失败");
            expect((err as Error).message).not.toMatch(/\.toml/);
        }
    });

    it("非 JSON 对象（数组 / 字符串 / null）→ ConfigError", () => {
        expect(() => parseInlineConfig("[1,2]")).toThrow(/JSON 对象/);
        expect(() => parseInlineConfig('"x"')).toThrow(/JSON 对象/);
        expect(() => parseInlineConfig("null")).toThrow(/JSON 对象/);
    });

    it("[log] 段非法 → ConfigError（归入 78 一族）", () => {
        const doc = { ...inlineDoc("10086"), log: { level: "verbose" } };
        expect(() => parseInlineConfig(JSON.stringify(doc))).toThrow(ConfigError);
    });
});

describe("loadCliConfigWithSource 优先级矩阵", () => {
    it("内联与文件同时设置：内联生效，且不读、不生成任何 toml 文件", async () => {
        const cfgPath = join(tmp, "napuketto.toml");
        process.env["NAPKETTO_CONFIG_JSON"] = JSON.stringify(inlineDoc("10086"));
        process.env["NAPKETTO_CONFIG"] = cfgPath;
        const { config, source, path } = await loadCliConfigWithSource({ dataDir: tmp });
        expect(source).toBe("inline");
        expect(config.accounts[0]?.qq).toBe("10086");
        expect(path).toBeUndefined();
        // 内联模式零文件落盘：文件形态的 ensureConfigTemplate 不得触发
        expect(existsSync(cfgPath)).toBe(false);
        expect(mocks.logger.info).toHaveBeenCalledWith("配置来源: inline（NAPKETTO_CONFIG_JSON）");
    });

    it("内联为空串：回退文件形态（读取已有 toml）", async () => {
        const cfgPath = join(tmp, "napuketto.toml");
        writeFileSync(cfgPath, 'autoRestart = false\n[[accounts]]\nqq = "10001"\n');
        process.env["NAPKETTO_CONFIG_JSON"] = "   ";
        process.env["NAPKETTO_CONFIG"] = cfgPath;
        const { config, source, path } = await loadCliConfigWithSource({ dataDir: tmp });
        expect(source).toBe("file");
        expect(path).toBe(cfgPath);
        expect(config.accounts[0]?.qq).toBe("10001");
        expect(config.autoRestart).toBe(false);
    });

    // 仅 POSIX 可测——Windows 的 process.env 大小写不敏感，别名键无法与原名共存
    it.runIf(process.platform !== "win32")(
        "大小写别名拼写（NAPKETTO_CONFIG_json）不识别 → 文件形态",
        async () => {
            const cfgPath = join(tmp, "napuketto.toml");
            writeFileSync(cfgPath, '[[accounts]]\nqq = "10001"\n');
            process.env["NAPKETTO_CONFIG_json"] = JSON.stringify(inlineDoc("10086"));
            process.env["NAPKETTO_CONFIG"] = cfgPath;
            const { source, config } = await loadCliConfigWithSource({ dataDir: tmp });
            expect(source).toBe("file");
            expect(config.accounts[0]?.qq).toBe("10001");
            delete process.env["NAPKETTO_CONFIG_json"];
        },
    );

    it("内联占位 qq → ConfigError，且文件形态的模板不被生成", async () => {
        const cfgPath = join(tmp, "napuketto.toml");
        process.env["NAPKETTO_CONFIG_JSON"] = JSON.stringify(inlineDoc("123456"));
        process.env["NAPKETTO_CONFIG"] = cfgPath;
        await expect(loadCliConfigWithSource({ dataDir: tmp })).rejects.toThrow(ConfigError);
        expect(existsSync(cfgPath)).toBe(false);
    });
});
