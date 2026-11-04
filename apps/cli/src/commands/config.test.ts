/**
 * config.test.ts：config 子命令单测（init / list / apply / validate）。
 *
 * validate：四态（文件合法 / 文件非法 / 内联合法 / 内联非法）+ 无参形态（生效配置；
 * 文件缺失纯只读报「配置文件不存在」不落模板）+ 参数冲突（用法错误）。
 * init / list / apply：模板落盘与已存在跳过、账号目录列举、外部配置合并校验与
 * 非法输入（缺失文件 / 非 JSON / 非对象 / 合并结果非法不写回）。
 * 错误一概 ConfigError（宿主/脚本消费 exit 78），文件形态文案与运行时逐字一致。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { ConfigError } from "@napuketto/kernel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../logger.js", () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logger } from "../logger.js";
import { cmdConfigApply, cmdConfigInit, cmdConfigList, cmdConfigValidate } from "./config.js";

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

describe("cmdConfigInit", () => {
    it("配置缺失 → 生成模板（文件内容 = 模板 + 换行）并 stdout 原样输出", async () => {
        const cfgPath = join(tmp, "napuketto.toml");
        process.env["NAPKETTO_CONFIG"] = cfgPath;
        const writes: string[] = [];
        const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
            writes.push(String(chunk));
            return true;
        }) as never);
        try {
            await cmdConfigInit({ dataDir: tmp });
        } finally {
            spy.mockRestore();
        }
        expect(existsSync(cfgPath)).toBe(true);
        const content = readFileSync(cfgPath, "utf8");
        expect(content.startsWith("# =")).toBe(true);
        expect(content.endsWith("\n")).toBe(true);
        expect(writes.join("")).toBe(content);
        expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
            { path: cfgPath },
            "全局配置已生成（请编辑 accounts 段填入 QQ 号）",
        );
    });

    it("配置已存在 → 跳过生成（不覆盖用户配置），输出原文件内容", async () => {
        const cfgPath = join(tmp, "napuketto.toml");
        process.env["NAPKETTO_CONFIG"] = cfgPath;
        writeFileSync(cfgPath, '[[accounts]]\nqq = "10001"\n', "utf8");
        const writes: string[] = [];
        const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
            writes.push(String(chunk));
            return true;
        }) as never);
        try {
            await cmdConfigInit({ dataDir: tmp });
        } finally {
            spy.mockRestore();
        }
        expect(readFileSync(cfgPath, "utf8")).toBe('[[accounts]]\nqq = "10001"\n');
        expect(writes.join("")).toBe('[[accounts]]\nqq = "10001"\n');
        expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
            { path: cfgPath },
            "全局配置已存在（跳过生成，避免覆盖用户配置）",
        );
    });
});

describe("cmdConfigList", () => {
    it("列出全局配置 TOML 与各账号 config 目录文件清单", async () => {
        const cfgPath = join(tmp, "napuketto.toml");
        process.env["NAPKETTO_CONFIG"] = cfgPath;
        writeFileSync(cfgPath, '[[accounts]]\nqq = "10001"\n', "utf8");
        mkdirSync(join(tmp, "账号A", "config"), { recursive: true });
        writeFileSync(join(tmp, "账号A", "config", "a.json"), "{}", "utf8");
        writeFileSync(join(tmp, "账号A", "config", "b.toml"), "", "utf8");
        writeFileSync(join(tmp, "账号A", "config", "c.txt"), "", "utf8");
        mkdirSync(join(tmp, "账号B"), { recursive: true }); // 无 config 子目录
        writeFileSync(join(tmp, "非目录.txt"), "", "utf8"); // 文件不算账号
        const writes: string[] = [];
        const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
            writes.push(String(chunk));
            return true;
        }) as never);
        try {
            await cmdConfigList({ dataDir: tmp });
        } finally {
            spy.mockRestore();
        }
        const stdout = writes.join("");
        expect(stdout).toContain('qq = "10001"');
        const infoCalls = vi.mocked(logger.info).mock.calls;
        // 账号 A：json/toml 入清单，txt 排除
        expect(infoCalls).toContainEqual([
            { account: "账号A", files: "a.json, b.toml" },
            "账号配置",
        ]);
        // 账号 B：config 目录未初始化
        expect(infoCalls).toContainEqual([{ account: "账号B", files: "（未初始化）" }, "账号配置"]);
        // 非目录文件不作为账号列出
        expect(infoCalls.some((call) => JSON.stringify(call).includes("非目录.txt"))).toBe(false);
    });

    it("配置缺失 → store.load 报 ConfigError 且不落盘（模板兜底在 loadCliConfigWithSource 层）", async () => {
        const cfgPath = join(tmp, "napuketto.toml");
        process.env["NAPKETTO_CONFIG"] = cfgPath;
        await expect(cmdConfigList({ dataDir: tmp })).rejects.toThrow(ConfigError);
        expect(existsSync(cfgPath)).toBe(false);
    });
});

describe("cmdConfigApply", () => {
    it("TOML 补丁覆盖合并：全局字段覆盖、accounts 保留、写回并 stdout 输出", async () => {
        const cfgPath = join(tmp, "napuketto.toml");
        process.env["NAPKETTO_CONFIG"] = cfgPath;
        writeFileSync(cfgPath, 'autoRestart = true\n[[accounts]]\nqq = "10001"\n', "utf8");
        const patchPath = join(tmp, "patch.toml");
        writeFileSync(patchPath, "autoRestart = false\nrestartDelayMs = 4000\n", "utf8");
        const writes: string[] = [];
        const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
            writes.push(String(chunk));
            return true;
        }) as never);
        try {
            await cmdConfigApply(patchPath, { dataDir: tmp });
        } finally {
            spy.mockRestore();
        }
        expect(vi.mocked(logger.info)).toHaveBeenCalledWith({ path: cfgPath }, "全局配置已更新");
        const stdout = writes.join("");
        expect(stdout).toContain("autoRestart = false");
        expect(stdout).toContain("restartDelayMs = 4000");
        expect(stdout).toContain('qq = "10001"');
        // 写回内容与 stdout 一致
        expect(readFileSync(cfgPath, "utf8")).toBe(stdout);
    });

    it("JSON 补丁（按扩展名解析）同样生效", async () => {
        const cfgPath = join(tmp, "napuketto.toml");
        process.env["NAPKETTO_CONFIG"] = cfgPath;
        writeFileSync(cfgPath, '[[accounts]]\nqq = "10001"\n', "utf8");
        const patchPath = join(tmp, "patch.json");
        writeFileSync(patchPath, '{"autoRestart": false}', "utf8");
        await cmdConfigApply(patchPath, { dataDir: tmp });
        expect(readFileSync(cfgPath, "utf8")).toContain("autoRestart = false");
    });

    it("外部配置文件缺失 → kernelError（INVALID_PARAM 语义，exit 1）", async () => {
        const cfgPath = join(tmp, "napuketto.toml");
        process.env["NAPKETTO_CONFIG"] = cfgPath;
        writeFileSync(cfgPath, '[[accounts]]\nqq = "10001"\n', "utf8");
        await expect(cmdConfigApply(join(tmp, "缺失.toml"), { dataDir: tmp })).rejects.toThrow(
            /读取外部配置失败/,
        );
    });

    it("JSON 补丁非法 → kernelError「不是合法 JSON」", async () => {
        const cfgPath = join(tmp, "napuketto.toml");
        process.env["NAPKETTO_CONFIG"] = cfgPath;
        writeFileSync(cfgPath, '[[accounts]]\nqq = "10001"\n', "utf8");
        const patchPath = join(tmp, "bad.json");
        writeFileSync(patchPath, "{oops", "utf8");
        await expect(cmdConfigApply(patchPath, { dataDir: tmp })).rejects.toThrow(/不是合法 JSON/);
    });

    it("补丁为原始值（非对象）→ kernelError「必须是对象」", async () => {
        const cfgPath = join(tmp, "napuketto.toml");
        process.env["NAPKETTO_CONFIG"] = cfgPath;
        writeFileSync(cfgPath, '[[accounts]]\nqq = "10001"\n', "utf8");
        const patchPath = join(tmp, "scalar.json");
        writeFileSync(patchPath, "42", "utf8");
        await expect(cmdConfigApply(patchPath, { dataDir: tmp })).rejects.toThrow(/必须是对象/);
    });

    it("合并结果非法（accounts 清空）→ ConfigError 且不写回", async () => {
        const cfgPath = join(tmp, "napuketto.toml");
        process.env["NAPKETTO_CONFIG"] = cfgPath;
        const original = 'autoRestart = true\n[[accounts]]\nqq = "10001"\n';
        writeFileSync(cfgPath, original, "utf8");
        const patchPath = join(tmp, "empty-accounts.json");
        writeFileSync(patchPath, '{"accounts": []}', "utf8");
        await expect(cmdConfigApply(patchPath, { dataDir: tmp })).rejects.toThrow(ConfigError);
        expect(readFileSync(cfgPath, "utf8")).toBe(original);
    });
});
