import {
    chmodSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONFIG_FILE_MODE, ConfigBase } from "../../src/infra/config.js";
import { ConfigError } from "../../src/infra/errors.js";

vi.mock("node:fs/promises", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs/promises")>();
    return {
        ...actual,
        open: vi.fn(actual.open),
        readFile: vi.fn(actual.readFile),
        rename: vi.fn(actual.rename),
    };
});

interface Item {
    name: string;
}

const defaults: Item = { name: "default" };
const schema = {
    parse(input: unknown): Item {
        if (
            typeof input !== "object" ||
            input === null ||
            !("name" in input) ||
            typeof input.name !== "string" ||
            input.name === ""
        ) {
            throw new Error("name 必须是非空字符串");
        }
        return { name: input.name };
    },
};

let tmp = "";

function makeStore(fileName = "item.json", seed?: Item): ConfigBase<Item> {
    if (!tmp) tmp = mkdtempSync(join(tmpdir(), "napuketto-config-concurrency-"));
    return new ConfigBase({ path: join(tmp, fileName), schema, defaults, seed });
}

function disk(store: ConfigBase<Item>): Item {
    return store.parseText(readFileSync(store.path, "utf8"));
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(fs.open).mockReset();
    vi.mocked(fs.readFile).mockReset();
    vi.mocked(fs.rename).mockReset();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = "";
});

// mockReset 后恢复透传；故障注入只替换对应测试的单次调用。
async function realFs() {
    const actual = await vi.importActual<typeof fs>("node:fs/promises");
    vi.mocked(fs.open).mockImplementation(actual.open);
    vi.mocked(fs.readFile).mockImplementation(actual.readFile);
    vi.mocked(fs.rename).mockImplementation(actual.rename);
    return actual;
}

describe("ConfigBase 并发提交", () => {
    it.each(["json", "toml"])(
        "同实例并发保存按调用顺序提交，最终内存/文件一致（%s）",
        async (format) => {
            await realFs();
            const store = makeStore(`item.${format}`);
            const commits: Item[] = [];
            const actual = await vi.importActual<typeof fs>("node:fs/promises");
            vi.mocked(fs.rename).mockImplementation(async (from, to) => {
                await actual.rename(from, to);
                commits.push(disk(store));
            });
            const values = Array.from({ length: 12 }, (_, i) => ({ name: `value-${i}` }));
            const results = await Promise.allSettled(values.map((value) => store.save(value)));
            expect(results.map((r) => r.status)).toEqual(values.map(() => "fulfilled"));
            expect(commits).toEqual(values);
            expect(store.get()).toEqual(values.at(-1));
            expect(disk(store)).toEqual(store.get());
            expect(readdirSync(tmp)).toEqual([`item.${format}`]);
        },
    );

    it("排队保存使用调用时快照；rename 成功前不发布内存值", async () => {
        const actual = await realFs();
        const store = makeStore();
        await store.save({ name: "committed" });
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        vi.mocked(fs.rename).mockImplementationOnce(async (from, to) => {
            entered.resolve();
            await release.promise;
            await actual.rename(from, to);
        });
        const first = store.save({ name: "first" });
        await entered.promise;
        const next = { name: "second" };
        const second = store.save(next);
        next.name = "mutated";
        try {
            expect(store.get()).toEqual({ name: "committed" });
            expect(disk(store)).toEqual(store.get());
        } finally {
            release.resolve();
            await Promise.allSettled([first, second]);
        }
        await expect(first).resolves.toBeUndefined();
        await expect(second).resolves.toBeUndefined();
        expect(store.get()).toEqual({ name: "second" });
        expect(disk(store)).toEqual(store.get());
    });

    it("首个 rename 已替换但尚未返回时，后续 save 不能越过它发布内存", async () => {
        const actual = await realFs();
        const store = makeStore();
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        vi.mocked(fs.rename).mockImplementationOnce(async (from, to) => {
            await actual.rename(from, to);
            entered.resolve();
            await release.promise;
        });
        const first = store.save({ name: "first" });
        await entered.promise;
        const second = store.save({ name: "second" });
        try {
            // 留出一次真实 I/O 的执行窗口，模拟 rename 完成通知被延迟。
            expect(await Promise.race([second.then(() => "committed"), delay(40, "waiting")])).toBe(
                "waiting",
            );
            expect(disk(store)).toEqual({ name: "first" });
            expect(store.get()).toEqual(defaults);
        } finally {
            release.resolve();
            await Promise.allSettled([first, second]);
        }
        expect(store.get()).toEqual({ name: "second" });
        expect(disk(store)).toEqual(store.get());
    });

    it("不同实例的临时文件互相隔离；最终文件由最后 rename 决定", async () => {
        const actual = await realFs();
        const firstStore = makeStore();
        const secondStore = makeStore();
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        vi.mocked(fs.rename).mockImplementationOnce(async (from, to) => {
            entered.resolve();
            await release.promise;
            await actual.rename(from, to);
        });
        const first = firstStore.save({ name: "first" });
        await entered.promise;
        const second = secondStore.save({ name: "second" });
        try {
            await second;
            expect(disk(secondStore)).toEqual({ name: "second" });
        } finally {
            release.resolve();
            await Promise.allSettled([first, second]);
        }
        await expect(first).resolves.toBeUndefined();
        expect(disk(firstStore)).toEqual({ name: "first" });
        expect(firstStore.get()).toEqual({ name: "first" });
        expect(secondStore.get()).toEqual({ name: "second" });
        const paths = vi.mocked(fs.rename).mock.calls.map(([from]) => from);
        expect(new Set(paths).size).toBe(2);
        expect(readdirSync(tmp)).toEqual(["item.json"]);
    });

    it("首次 load 与后续 save 共用顺序，默认值不会迟到覆盖", async () => {
        const actual = await realFs();
        const store = makeStore();
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        vi.mocked(fs.readFile).mockImplementationOnce(async (...args) => {
            entered.resolve();
            await release.promise;
            return actual.readFile(...args);
        });
        const loading = store.load();
        await entered.promise;
        const saving = store.save({ name: "saved" });
        release.resolve();
        const results = await Promise.allSettled([loading, saving]);
        expect(results[0]).toEqual({ status: "fulfilled", value: defaults });
        expect(results[1]).toEqual({ status: "fulfilled", value: undefined });
        expect(store.get()).toEqual({ name: "saved" });
        expect(disk(store)).toEqual(store.get());
        const [one, two] = await Promise.all([store.load(), store.load()]);
        expect(one).toEqual(two);
    });

    it("save 后立即 load 读取已提交值", async () => {
        await realFs();
        const store = makeStore();
        await store.save(defaults);
        const saving = store.save({ name: "saved" });
        const loading = store.load();
        await Promise.allSettled([saving, loading]);
        await expect(loading).resolves.toEqual({ name: "saved" });
        await saving;
        expect(disk(store)).toEqual(store.get());
    });
});

describe("ConfigBase 失败清理及权限", () => {
    it("独占创建碰撞不会覆盖或删除不属于本次提交的临时文件", async () => {
        const actual = await realFs();
        const store = makeStore();
        let occupied = "";
        vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
            occupied = String(args[0]);
            writeFileSync(occupied, "another writer");
            return actual.open(...args);
        });
        await expect(store.save({ name: "rejected" })).rejects.toMatchObject({ code: "EEXIST" });
        expect(readFileSync(occupied, "utf8")).toBe("another writer");
        expect(store.get()).toEqual(defaults);
        rmSync(occupied);
        await store.save({ name: "recovered" });
        expect(disk(store)).toEqual({ name: "recovered" });
    });

    it.each(["write", "close", "rename", ...(process.platform === "win32" ? [] : ["chmod"])])(
        "%s 失败清理临时文件，保留上次提交并允许队列继续",
        async (stage) => {
            const actual = await realFs();
            const store = makeStore();
            await store.save({ name: "committed" });
            const failure = new Error(`injected ${stage} failure`);
            if (stage === "rename") {
                vi.mocked(fs.rename).mockRejectedValueOnce(failure);
            } else {
                vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
                    const handle = await actual.open(...args);
                    if (stage === "write") {
                        vi.spyOn(handle, "writeFile").mockImplementationOnce(async () => {
                            await handle.writeFile("partial secret");
                            throw failure;
                        });
                    } else if (stage === "close") {
                        const close = handle.close.bind(handle);
                        vi.spyOn(handle, "close").mockImplementationOnce(async () => {
                            await close();
                            throw failure;
                        });
                    } else {
                        vi.spyOn(handle, "chmod").mockRejectedValueOnce(failure);
                    }
                    return handle;
                });
            }
            await expect(store.save({ name: "rejected" })).rejects.toBe(failure);
            expect(store.get()).toEqual({ name: "committed" });
            expect(disk(store)).toEqual(store.get());
            expect(readdirSync(tmp)).toEqual(["item.json"]);
            await store.save({ name: "recovered" });
            expect(store.get()).toEqual({ name: "recovered" });
            expect(disk(store)).toEqual(store.get());
        },
    );

    it("拒绝校验错误不写盘、不改变内存、不阻塞有效保存", async () => {
        await realFs();
        const store = makeStore();
        const invalid = store.save({ name: "" });
        const valid = store.save({ name: "valid" });
        await expect(invalid).rejects.toMatchObject({
            name: "ConfigError",
            code: "INVALID_PARAM",
            message: `配置文件校验失败: ${store.path}`,
        });
        await valid;
        expect(store.get()).toEqual({ name: "valid" });
        expect(disk(store)).toEqual(store.get());
        expect(fs.open).toHaveBeenCalledTimes(1);
    });

    it("不覆盖或清理历史固定 .tmp 文件", async () => {
        await realFs();
        const store = makeStore();
        writeFileSync(`${store.path}.tmp`, "unrelated temp");
        await store.save({ name: "secret" });
        expect(readFileSync(`${store.path}.tmp`, "utf8")).toBe("unrelated temp");
        expect(disk(store)).toEqual(store.get());
    });

    it.runIf(process.platform !== "win32")(
        "临时文件与最终文件均为 0o600，收紧已有宽权限目标",
        async () => {
            const actual = await realFs();
            const store = makeStore();
            await store.load();
            expect(statSync(store.path).mode & 0o777).toBe(CONFIG_FILE_MODE);
            chmodSync(store.path, 0o644);
            vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
                expect(args[1]).toBe("wx");
                expect(args[2]).toBe(CONFIG_FILE_MODE);
                const handle = await actual.open(...args);
                vi.spyOn(handle, "writeFile").mockImplementationOnce(async (...writeArgs) => {
                    expect((await handle.stat()).mode & 0o777).toBe(CONFIG_FILE_MODE);
                    await handle.writeFile(...writeArgs);
                });
                return handle;
            });
            await store.save({ name: "secret" });
            expect(statSync(store.path).mode & 0o777).toBe(CONFIG_FILE_MODE);
        },
    );

    it("seed load 不读写文件；显式 save 仍落盘，再 load 恢复 seed", async () => {
        await realFs();
        const store = makeStore("seed.json", { name: "seed" });
        await expect(store.load()).resolves.toEqual({ name: "seed" });
        expect(fs.readFile).not.toHaveBeenCalled();
        expect(readdirSync(tmp)).toEqual([]);
        await store.save({ name: "saved" });
        expect(disk(store)).toEqual({ name: "saved" });
        await expect(store.load()).resolves.toEqual({ name: "seed" });
        expect(disk(store)).toEqual({ name: "saved" });
        expect(fs.readFile).not.toHaveBeenCalled();
    });

    it("读取校验失败后仍可保存", async () => {
        await realFs();
        const store = makeStore();
        writeFileSync(store.path, '{"name":""}');
        await expect(store.load()).rejects.toBeInstanceOf(ConfigError);
        await store.save({ name: "repaired" });
        expect(disk(store)).toEqual(store.get());
    });
});
