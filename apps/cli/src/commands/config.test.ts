/**
 * config.test.ts：config 子命令单测（config validate，2026-10-25）。
 *
 * 覆盖四态（文件合法 / 文件非法 / 内联合法 / 内联非法）+ 无参形态（生效配置；
 * 文件缺失纯只读报「配置文件不存在」不落模板）+ 参数冲突（用法错误）。
 * 错误一概 ConfigError（宿主/脚本消费 exit 78），文件形态文案与运行时逐字一致。
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { ConfigError } from "@napuketto/kernel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../logger.js", () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { cmdConfigValidate } from "./config.js";

let tmp = "";
const inline = JSON.stringify({ autoRestart: true, accounts: [{ qq: "10086" }] });

beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "napuketto-validate-test-"));
    delete process.env["NAPKETTO_CONFIG_JSON"];
    delete process.env["NAPKETTO_CONFIG"];
    delete process.env["NAPKETTO_DATA"];
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

describe("cmdConfigValidate 显式形态", () => {
    it("--config 合法 toml → file 来源 + 路径，exit 语义 = 通过", async () => {
        const path = join(tmp, "napuketto.toml");
        writeFileSync(path, 'autoRestart = true\n[[accounts]]\nqq = "10001"\n');
        const result = await cmdConfigValidate({ configPath: path, dataDir: tmp });
        expect(result).toEqual({ source: "file", path });
    });

    it("--config 校验失败 → ConfigError，文案与运行时逐字一致（含 path）", async () => {
        const path = join(tmp, "napuketto.toml");
        writeFileSync(path, '[[accounts]]\nqq = "123456"\n');
        try {
            await cmdConfigValidate({ configPath: path, dataDir: tmp });
            expect.unreachable("应抛出 ConfigError");
        } catch (err) {
            expect(err).toBeInstanceOf(ConfigError);
            expect((err as Error).message).toBe(`配置文件校验失败: ${path}`);
        }
    });

    it("--config 指向缺失文件 → 「配置文件不存在」，且不落模板（纯只读）", async () => {
        const path = join(tmp, "不存在.toml");
        await expect(cmdConfigValidate({ configPath: path, dataDir: tmp })).rejects.toThrow(
            /配置文件不存在/,
        );
        expect(existsSync(path)).toBe(false);
    });

    it("--config-json 合法 → inline 来源", async () => {
        const result = await cmdConfigValidate({ configJson: inline, dataDir: tmp });
        expect(result).toEqual({ source: "inline" });
    });

    it("--config-json 占位 qq → ConfigError，文案不含 toml 路径", async () => {
        try {
            await cmdConfigValidate({
                configJson: JSON.stringify({ accounts: [{ qq: "123456" }] }),
                dataDir: tmp,
            });
            expect.unreachable("应抛出 ConfigError");
        } catch (err) {
            expect(err).toBeInstanceOf(ConfigError);
            expect((err as Error).message).toContain("占位值");
            expect((err as Error).message).not.toMatch(/\.toml/);
        }
    });

    it("--config 与 --config-json 同给 → 用法错误（非 ConfigError，exit 1 语义）", async () => {
        await expect(
            cmdConfigValidate({
                configPath: join(tmp, "a.toml"),
                configJson: inline,
                dataDir: tmp,
            }),
        ).rejects.toThrow(/只能二选一/);
        await expect(
            cmdConfigValidate({
                configPath: join(tmp, "a.toml"),
                configJson: inline,
                dataDir: tmp,
            }),
        ).rejects.not.toThrow(ConfigError);
    });
});

describe("cmdConfigValidate 无参形态（生效配置）", () => {
    it("内联 env 生效 → inline 来源", async () => {
        process.env["NAPKETTO_CONFIG_JSON"] = inline;
        const result = await cmdConfigValidate({ dataDir: tmp });
        expect(result).toEqual({ source: "inline" });
    });

    it("无内联 + NAPKETTO_CONFIG 指向缺失文件 → 配置缺失报 78 族，不落模板", async () => {
        const path = join(tmp, "缺失.toml");
        process.env["NAPKETTO_CONFIG"] = path;
        await expect(cmdConfigValidate({ dataDir: tmp })).rejects.toThrow(/配置文件不存在/);
        expect(existsSync(path)).toBe(false);
    });

    it("无内联 + NAPKETTO_CONFIG 指向合法文件 → file 来源", async () => {
        const path = join(tmp, "napuketto.toml");
        writeFileSync(path, '[[accounts]]\nqq = "10001"\n');
        process.env["NAPKETTO_CONFIG"] = path;
        const result = await cmdConfigValidate({ dataDir: tmp });
        expect(result).toEqual({ source: "file", path });
    });
});
