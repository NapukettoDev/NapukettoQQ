/**
 * core/framework/config.test.ts：ProtocolConfig（ConfigBase 复用）单测。
 *
 * 锁定：seed 优先（不读文件）、文件缺失落默认值、TOML 文件加载、
 * 解析/校验失败抛 ConfigError（code=INVALID_PARAM）、parseText 只读校验。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "@napuketto/kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { ProtocolConfig } from "../config.js";

const schema = z.object({
    token: z.string().optional(),
    count: z.number().int().default(3),
});
type Cfg = z.infer<typeof schema>;

let tmpRoot = "";

beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "nk-test-protocol-config-"));
});

afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
});

/** 在临时目录写文件并返回路径。 */
function tempFile(name: string, content: string): string {
    const p = join(tmpRoot, name);
    writeFileSync(p, content, "utf8");
    return p;
}

describe("ProtocolConfig.load", () => {
    it("seed 存在：load 直接返回 seed，不读文件（路径可不存在）", async () => {
        const seed: Cfg = { count: 9 };
        const config = new ProtocolConfig<Cfg>({
            path: join(tmpRoot, "never-exists.toml"),
            schema,
            defaults: schema.parse({}),
            seed,
        });
        await expect(config.load()).resolves.toEqual({ count: 9 });
    });

    it("文件缺失：load 落盘默认值并返回", async () => {
        const path = join(tmpRoot, "missing.toml");
        const defaults = schema.parse({});
        const config = new ProtocolConfig<Cfg>({ path, schema, defaults });
        await expect(config.load()).resolves.toEqual(defaults);
        expect(readFileSync(path, "utf8")).toContain("count = 3");
    });

    it("TOML 文件存在：读取 + 校验 + 更新内存", async () => {
        const path = tempFile("loaded.toml", 'token = "abc"\ncount = 7\n');
        const config = new ProtocolConfig<Cfg>({ path, schema, defaults: schema.parse({}) });
        await expect(config.load()).resolves.toEqual({ token: "abc", count: 7 });
        // 二次 load 读的是文件而非内存残留
        writeFileSync(path, "count = 8\n", "utf8");
        await expect(config.load()).resolves.toEqual({ count: 8 });
    });

    it("JSON 文件（按扩展名推断格式）：正常加载", async () => {
        const path = tempFile("loaded.json", JSON.stringify({ token: "t", count: 2 }));
        const config = new ProtocolConfig<Cfg>({ path, schema, defaults: schema.parse({}) });
        await expect(config.load()).resolves.toEqual({ token: "t", count: 2 });
    });

    it("TOML 语法错误：抛 ConfigError（INVALID_PARAM）", async () => {
        const path = tempFile("bad-syntax.toml", "key = [未闭合\n");
        const config = new ProtocolConfig<Cfg>({ path, schema, defaults: schema.parse({}) });
        await expect(config.load()).rejects.toBeInstanceOf(ConfigError);
        await expect(config.load()).rejects.toMatchObject({ code: "INVALID_PARAM" });
    });

    it("schema 校验失败：抛 ConfigError", async () => {
        const path = tempFile("bad-schema.toml", 'count = "not-a-number"\n');
        const config = new ProtocolConfig<Cfg>({ path, schema, defaults: schema.parse({}) });
        await expect(config.load()).rejects.toBeInstanceOf(ConfigError);
    });
});

describe("ProtocolConfig.save 与 parseText", () => {
    it("save：校验后原子落盘（TOML）并更新内存", async () => {
        const path = join(tmpRoot, "save.toml");
        const config = new ProtocolConfig<Cfg>({ path, schema, defaults: schema.parse({}) });
        await config.save({ token: "xyz", count: 5 });
        expect(readFileSync(path, "utf8")).toContain("count = 5");
        // save 后 get() 反映新值；load 也返回落盘内容
        expect(config.get()).toEqual({ token: "xyz", count: 5 });
        await expect(config.load()).resolves.toEqual({ token: "xyz", count: 5 });
    });

    it("save 校验失败：抛 ConfigError 且不更新内存", async () => {
        const path = join(tmpRoot, "save-bad.json");
        const config = new ProtocolConfig<Cfg>({ path, schema, defaults: schema.parse({}) });
        const bad = { count: "no" } as unknown as Cfg;
        await expect(config.save(bad)).rejects.toBeInstanceOf(ConfigError);
        expect(config.get()).toEqual(schema.parse({}));
    });

    it("parseText：只校验文本不读写文件", () => {
        const config = new ProtocolConfig<Cfg>({
            path: join(tmpRoot, "no-touch.toml"),
            schema,
            defaults: schema.parse({}),
        });
        expect(config.parseText("count = 1")).toEqual({ count: 1 });
        expect(() => config.parseText('count = "x"')).toThrow(ConfigError);
    });
});
