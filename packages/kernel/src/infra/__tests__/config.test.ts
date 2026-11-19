/**
 * config.test.ts：ConfigBase 只读校验单测（2026-10-25 嵌入式退出码）。
 *
 * 覆盖：parseText 反序列化/校验错误包装（文案含 path，与运行时逐字一致）、
 * load() 缺失文件落默认值行为不回退、save() 往返校验。不触真实 wrapper.node
 * （infra 层纯逻辑）。
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigBase } from "../config.js";
import { ConfigError } from "../errors.js";

interface Item {
    name: string;
}

/** 最小 schema：要求 name 非空字符串（手写校验器形状）。 */
const itemSchema = {
    parse(input: unknown): Item {
        if (
            typeof input !== "object" ||
            input === null ||
            typeof (input as { name?: unknown }).name !== "string" ||
            (input as { name: string }).name === ""
        ) {
            throw new Error("name 必须是非空字符串");
        }
        return { name: (input as { name: string }).name };
    },
};

const defaults: Item = { name: "default" };

let tmp = "";

afterEach(() => {
    if (tmp !== "") {
        rmSync(tmp, { recursive: true, force: true });
        tmp = "";
    }
});

function makeStore(fileName: string): ConfigBase<Item> {
    tmp = mkdtempSync(join(tmpdir(), "napuketto-config-test-"));
    return new ConfigBase<Item>({
        path: join(tmp, fileName),
        schema: itemSchema,
        defaults,
    });
}

describe("ConfigBase.parseText（只读校验）", () => {
    it("合法 TOML 文本 → 解析结果，不读写文件", () => {
        const store = makeStore("item.toml");
        expect(store.parseText('name = "abc"\n')).toEqual({ name: "abc" });
    });

    it("schema 校验失败 → ConfigError，文案含 path 且带 cause", () => {
        const store = makeStore("item.toml");
        try {
            store.parseText('name = ""\n');
            expect.unreachable("应抛出 ConfigError");
        } catch (err) {
            expect(err).toBeInstanceOf(ConfigError);
            expect((err as ConfigError).message).toBe(
                `配置文件校验失败: ${join(tmp, "item.toml")}`,
            );
            expect((err as ConfigError).cause).toBeInstanceOf(Error);
        }
    });

    it("TOML 语法非法 → ConfigError（解析失败文案）", () => {
        const store = makeStore("item.toml");
        expect(() => store.parseText("name = [[\n")).toThrow(ConfigError);
        try {
            store.parseText("name = [[\n");
        } catch (err) {
            expect((err as ConfigError).message).toContain(
                `配置文件 TOML 解析失败: ${join(tmp, "item.toml")}`,
            );
        }
    });

    it(".json 扩展名按 JSON 反序列化（与运行时格式推断一致）", () => {
        const store = makeStore("item.json");
        expect(store.parseText('{"name":"xyz"}')).toEqual({ name: "xyz" });
        try {
            store.parseText("{not-json");
            expect.unreachable("应抛出 ConfigError");
        } catch (err) {
            expect((err as ConfigError).message).toContain(
                `配置文件 JSON 解析失败: ${join(tmp, "item.json")}`,
            );
        }
    });
});

describe("ConfigBase.load()/save() 行为不回退", () => {
    it("文件缺失 → 落默认值并写盘（首次运行自动生成）", async () => {
        const store = makeStore("item.toml");
        const value = await store.load();
        expect(value).toEqual(defaults);
        expect(readFileSync(store.path, "utf8")).toContain("default");
    });

    it("save() 往返（序列化 → 校验 → 落盘）", async () => {
        const store = makeStore("item.toml");
        await store.load();
        await store.save({ name: "next" });
        expect(readFileSync(store.path, "utf8")).toContain("next");
        expect(store.get()).toEqual({ name: "next" });
    });

    it.runIf(process.platform !== "win32")(
        "save() 落盘权限 0o600（POSIX，配置可能含 token）",
        async () => {
            const store = makeStore("item.toml");
            await store.load();
            await store.save({ name: "secret" });
            expect(statSync(store.path).mode & 0o777).toBe(0o600);
        },
    );
});
