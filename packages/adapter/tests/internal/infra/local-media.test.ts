import { existsSync } from "node:fs";
import {
    link,
    mkdir,
    mkdtemp,
    open,
    readFile,
    realpath,
    rename,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportQqMedia, resolveLocalMedia } from "../../../src/internal/infra/local-media.js";
import { cacheMediaFile, MediaCache } from "../../../src/internal/infra/media-cache.js";

vi.mock("node:fs/promises", async (original) => {
    const fs = await original<typeof import("node:fs/promises")>();
    return { ...fs, open: vi.fn(fs.open) };
});

const owner = { protocol: "onebot11", account: "10001" };
let temp: string;
let exports: string;
let sibling: string;
let cache: MediaCache;

beforeEach(async () => {
    temp = await realpath(await mkdtemp(join(tmpdir(), "nk-local-media-")));
    exports = join(temp, "exports");
    sibling = join(temp, "exports-other");
    await mkdir(exports);
    await mkdir(sibling);
    cache = new MediaCache({ root: temp, owner });
});

afterEach(async () => {
    vi.mocked(open).mockClear();
    await rm(temp, { recursive: true, force: true });
});

describe("本地媒体读取", () => {
    it("裸路径和 file URI 消费副本，原文件被替换也不影响原生重开", async () => {
        const source = join(exports, "音频.silk");
        await writeFile(source, "original");
        const paths: string[] = [];
        await cache.run(async () => {
            paths.push(await resolveLocalMedia("音频.silk", [exports]));
            paths.push(await resolveLocalMedia(pathToFileURL(source).href, [exports]));
            await rename(source, join(exports, "old.silk"));
            await writeFile(source, "replacement");
            for (const copy of paths) {
                expect(copy).not.toBe(source);
                expect(basename(copy)).toBe("音频.silk");
                expect(await readFile(copy, "utf8")).toBe("original");
            }
        });
        expect(paths[0]).not.toBe(paths[1]);
        expect(paths.every((path) => !existsSync(path))).toBe(true);
        expect(await readFile(source, "utf8")).toBe("replacement");
    });

    it("拒绝默认读取、兄弟目录、越根 junction/链接、硬链接和歧义", async () => {
        const outside = join(sibling, "file.bin");
        await writeFile(outside, "outside");
        await writeFile(join(exports, "file.bin"), "inside");
        await symlink(sibling, join(exports, "redirect"), "junction");
        await link(outside, join(exports, "hard.bin"));
        await cache.run(async () => {
            await expect(resolveLocalMedia(join(exports, "file.bin"))).rejects.toMatchObject({
                code: "INVALID_PARAM",
            });
            for (const path of [
                outside,
                "../exports-other/file.bin",
                "redirect/file.bin",
                "hard.bin",
            ]) {
                await expect(resolveLocalMedia(path, [exports])).rejects.toMatchObject({
                    code: "INVALID_PARAM",
                });
            }
            await expect(resolveLocalMedia("file.bin", [exports, sibling])).rejects.toMatchObject({
                code: "INVALID_PARAM",
            });
        });
        expect(open).not.toHaveBeenCalled();
    });

    it("打开时路径已更换则拒绝，不交付另一个文件", async () => {
        const original =
            await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
        const source = join(exports, "file.bin");
        const replacement = join(exports, "replacement.bin");
        await writeFile(source, "original");
        await writeFile(replacement, "replacement");
        vi.mocked(open).mockImplementationOnce(async (path, flags, mode) => {
            await rename(source, join(exports, "old.bin"));
            await rename(replacement, source);
            return await original.open(path, flags, mode);
        });
        await expect(cache.run(() => resolveLocalMedia(source, [exports]))).rejects.toMatchObject({
            code: "INVALID_PARAM",
        });
    });

    it("请求失败只清理自己的副本，并行消费者仍可用", async () => {
        const source = join(exports, "file.bin");
        await writeFile(source, "original");
        let failedPath = "";
        await cache.run(async () => {
            const active = await resolveLocalMedia(source, [exports]);
            const concurrent = new MediaCache({ root: temp, owner });
            await expect(
                concurrent.run(async () => {
                    failedPath = await resolveLocalMedia(source, [exports]);
                    expect(await readFile(failedPath, "utf8")).toBe("original");
                    throw new Error("native failed");
                }),
            ).rejects.toThrow("native failed");
            expect(failedPath).not.toBe(active);
            expect(existsSync(failedPath)).toBe(false);
            expect(await readFile(active, "utf8")).toBe("original");
            expect(await readFile(source, "utf8")).toBe("original");
        });
    });
});

describe("媒体引用归属", () => {
    it("缺省保留同账号协议的已发布缓存，宽授权根也不能读其他缓存", async () => {
        const path = await cache.run(() =>
            cacheMediaFile(
                temp,
                ".png",
                async (dest) => {
                    await writeFile(dest, "owned");
                },
                "reference",
            ),
        );
        await expect(cache.run(() => resolveLocalMedia(path))).resolves.toBe(path);
        for (const identity of [
            { protocol: "onebot11", account: "10002" },
            { protocol: "milky", account: "10001" },
        ]) {
            const foreign = new MediaCache({ root: temp, owner: identity });
            await expect(foreign.run(() => resolveLocalMedia(path, [temp]))).rejects.toMatchObject({
                code: "INVALID_PARAM",
            });
        }
    });

    it("QQ 资源只能从注入的目录导出，生成的引用和原文件分离", async () => {
        const path = join(exports, "qq.silk");
        const outside = join(sibling, "outside.silk");
        await writeFile(path, "qq resource");
        await writeFile(outside, "outside");
        const reference = await cache.run(() => exportQqMedia(path, exports, temp));
        expect(reference).not.toBe(path);
        expect(await cache.run(() => resolveLocalMedia(reference ?? ""))).toBe(reference);
        expect(await readFile(reference ?? "", "utf8")).toBe("qq resource");
        await expect(
            cache.run(() => exportQqMedia(outside, exports, temp)),
        ).resolves.toBeUndefined();
    });
});
