/**
 * config.ts ConfigBase 补充测试（基线之外的分支）：
 *  - seed：load() 直接用 seed 不读文件（全局 TOML 分段装配路径）
 *  - 非 ENOENT 读取错误 → ConfigError（区分缺失文件自动生成）
 *  - format 显式覆盖 / 大写 .TOML 扩展名推断
 *  - TOML 序列化往返（save → 磁盘 → load）
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigBase, parseToml, stringifyToml } from "../config.js";
import { ConfigError } from "../errors.js";

// readFile 包一层可 mock 的 spy（默认透传真实实现，load/save 其余调用不受影响）
vi.mock("node:fs/promises", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs/promises")>();
    return { ...actual, readFile: vi.fn(actual.readFile) };
});

interface Item {
    name: string;
}

/** 最小 schema：要求 name 非空字符串。 */
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

afterEach(async () => {
    if (tmp !== "") {
        rmSync(tmp, { recursive: true, force: true });
        tmp = "";
    }
    const { readFile } = await import("node:fs/promises");
    vi.mocked(readFile).mockClear();
});

function makeStore(
    fileName: string,
    opts: Partial<{ format: "json" | "toml"; seed: Item }> = {},
): ConfigBase<Item> {
    tmp = mkdtempSync(join(tmpdir(), "nk-test-config-"));
    return new ConfigBase<Item>({
        path: join(tmp, fileName),
        schema: itemSchema,
        defaults,
        ...(opts.format !== undefined ? { format: opts.format } : {}),
        ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
    });
}

describe("seed 路径", () => {
    it("load() 直接用 seed：不读文件、不落盘（内联配置零落盘契约）", async () => {
        const store = makeStore("seeded.json", { seed: { name: "from-seed" } });
        await expect(store.load()).resolves.toEqual({ name: "from-seed" });
        await expect(store.load()).resolves.toEqual({ name: "from-seed" });
    });

    it("constructor 初始内存值：seed 优先于 defaults（get 未 load 即可用）", () => {
        const seeded = makeStore("s2.json", { seed: { name: "s" } });
        expect(seeded.get()).toEqual({ name: "s" });
        const plain = makeStore("s3.json");
        expect(plain.get()).toEqual(defaults);
    });
});

describe("读取错误分支", () => {
    it("路径是目录（EISDIR 非 ENOENT）→ ConfigError 不自动生成", async () => {
        const store = makeStore("a-dir.json");
        // 把文件路径造成已存在的目录：readFile 得 EISDIR
        const { mkdirSync } = await import("node:fs");
        mkdirSync(store.path);
        await expect(store.load()).rejects.toBeInstanceOf(ConfigError);
        await expect(store.load()).rejects.toThrow(/读取配置文件失败/);
    });
});

describe("格式推断与显式覆盖", () => {
    it("大写 .TOML 扩展名同样推断为 toml", async () => {
        const store = makeStore("A.TOML");
        await store.save({ name: "toml-up" });
        const raw = readFileSync(store.path, "utf8");
        expect(raw).toContain('name = "toml-up"');
    });

    it("显式 format=json 写 .toml 后缀文件（内容为 JSON）", async () => {
        const store = makeStore("weird.toml", { format: "json" });
        await store.save({ name: "json-in-toml" });
        expect(JSON.parse(readFileSync(store.path, "utf8"))).toEqual({ name: "json-in-toml" });
    });
});

describe("TOML 往返", () => {
    it("save → load：TOML 序列化落盘后可读回（原子写 rename）", async () => {
        const store = makeStore("round.toml");
        await store.save({ name: "round-trip" });
        // 第二个实例指向同一文件（同一临时目录），只做读取验证
        const again = new ConfigBase<Item>({
            path: store.path,
            schema: itemSchema,
            defaults,
        });
        await expect(again.load()).resolves.toEqual({ name: "round-trip" });
        // 原子写：无 .tmp 残留
        const { existsSync } = await import("node:fs");
        expect(existsSync(`${store.path}.tmp`)).toBe(false);
    });

    it("save 内容非法（schema 拒绝）→ ConfigError 且不落盘", async () => {
        const store = makeStore("bad-save.toml");
        await expect(store.save({ name: "" })).rejects.toThrow(/配置文件校验失败/);
        const { existsSync } = await import("node:fs");
        expect(existsSync(store.path)).toBe(false);
    });
});

describe("独立工具函数", () => {
    it("parseToml / stringifyToml 独立可用（无 ConfigBase 场景复用）", () => {
        const text = stringifyToml({ a: 1, b: "x" });
        expect(parseToml(text)).toEqual({ a: 1, b: "x" });
    });

    it("parseToml 非法文本 → 原样抛错（不吞）", () => {
        expect(() => parseToml("broken ==== [")).toThrow();
    });

    it("load 读取抛非 Error 值 → ConfigError（isMissingFileError 兜底 false）", async () => {
        const { readFile } = await import("node:fs/promises");
        vi.mocked(readFile).mockRejectedValueOnce("raw-string-err");
        const store = new ConfigBase<Item>({
            path: join(tmpdir(), "nk-test-config-nonerr.json"),
            schema: itemSchema,
            defaults: { name: "d" },
        });
        await expect(store.load()).rejects.toMatchObject({
            name: "ConfigError",
            message: /读取配置文件失败/,
        });
    });
});
