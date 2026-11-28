import { randomUUID } from "node:crypto";
import {
    link,
    lstat,
    mkdir,
    mkdtemp,
    open,
    readdir,
    readFile,
    realpath,
    rename,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveLocalMedia } from "../../../src/internal/infra/local-media.js";
import { MEDIA_TEMP_ROOT, MediaCache } from "../../../src/internal/infra/media-cache.js";

vi.mock("node:fs/promises", async (importOriginal) => {
    const fs = await importOriginal<typeof import("node:fs/promises")>();
    return { ...fs, open: vi.fn(fs.open) };
});

describe("resolveLocalMedia", () => {
    let temp: string;
    let allowed: string;
    let sibling: string;
    let cacheRoot: string;
    let cache: MediaCache;

    beforeEach(async () => {
        temp = await realpath(await mkdtemp(join(tmpdir(), "nk-local-media-")));
        allowed = join(temp, "allowed");
        sibling = join(temp, "allowed-other");
        await mkdir(allowed);
        await mkdir(sibling);
        cache = new MediaCache({ owner: { protocol: "onebot11", account: randomUUID() } });
        const seed = await cache.run(() =>
            cache.create(MEDIA_TEMP_ROOT, ".bin", (path) => writeFile(path, "cache seed")),
        );
        cacheRoot = dirname(dirname(seed));
    });

    afterEach(async () => {
        vi.mocked(open).mockReset();
        await rm(cacheRoot, { recursive: true, force: true });
        await rm(temp, { recursive: true, force: true });
    });

    async function expectDenied(input: string, roots: readonly string[] = [allowed]) {
        await cache.run(async () => {
            await expect(resolveLocalMedia(input, roots)).rejects.toMatchObject({
                code: "INVALID_PARAM",
                message: "本地媒体路径未授权或文件不可用",
            });
            expect(await readdir(cacheRoot)).toEqual([]);
        });
    }

    it("裸相对路径和本机 file URI 都交付可重开的独立副本", async () => {
        const name = "原始 媒体.bin";
        const source = join(allowed, name);
        const original = Buffer.from([0, 1, 127, 255]);
        await writeFile(source, original);

        const copies = await cache.run(async () => {
            const relative = await resolveLocalMedia(name, [allowed]);
            const fileUrl = await resolveLocalMedia(pathToFileURL(source).href, [allowed]);
            expect(relative).not.toBe(fileUrl);
            await rename(source, join(allowed, "moved.bin"));
            await writeFile(source, "replacement");
            for (const copy of [relative, fileUrl]) {
                expect(basename(copy)).toBe(name);
                expect(await readFile(copy)).toEqual(original);
            }
            return [relative, fileUrl];
        });

        for (const copy of copies) {
            await expect(lstat(copy)).rejects.toMatchObject({ code: "ENOENT" });
        }
        expect(await readdir(cacheRoot)).toEqual([]);
        expect(await readFile(source, "utf8")).toBe("replacement");
        expect(await readFile(join(allowed, "moved.bin"))).toEqual(original);
    });

    it("未配置授权根时拒绝普通文件", async () => {
        const source = join(allowed, "media.bin");
        await writeFile(source, "original");

        await expectDenied(source, []);

        expect(await readFile(source, "utf8")).toBe("original");
    });

    it("拒绝同名前缀兄弟目录的绝对路径及相对越根路径", async () => {
        const outside = join(sibling, "media.bin");
        await writeFile(outside, "outside");

        await expectDenied(outside);
        await expectDenied(join("..", "allowed-other", "media.bin"));

        expect(await readdir(allowed)).toEqual([]);
        expect(await readFile(outside, "utf8")).toBe("outside");
    });

    it("相对路径在多个授权根命中不同文件时拒绝歧义", async () => {
        const inside = join(allowed, "media.bin");
        const outside = join(sibling, "media.bin");
        await writeFile(inside, "inside");
        await writeFile(outside, "outside");

        await expectDenied("media.bin", [allowed, sibling]);

        expect(await readFile(inside, "utf8")).toBe("inside");
        expect(await readFile(outside, "utf8")).toBe("outside");
    });

    it("拒绝解析到授权根外的目录链接", async () => {
        const outside = join(sibling, "media.bin");
        const alias = join(allowed, "linked");
        await writeFile(outside, "outside");
        await symlink(sibling, alias, process.platform === "win32" ? "junction" : "dir");

        await expectDenied(join("linked", "media.bin"));

        expect((await lstat(alias)).isSymbolicLink()).toBe(true);
        expect(await readFile(join(alias, "media.bin"), "utf8")).toBe("outside");
    });

    it("拒绝指向同一文件的硬链接，也拒绝非普通文件", async () => {
        const outside = join(sibling, "media.bin");
        const alias = join(allowed, "hard.bin");
        const directory = join(allowed, "directory.bin");
        await writeFile(outside, "outside");
        await link(outside, alias);
        await mkdir(directory);

        await expectDenied(alias);
        await expectDenied(directory);

        expect((await lstat(alias)).nlink).toBe(2);
        expect(await readFile(outside, "utf8")).toBe("outside");
        expect(await readdir(directory)).toEqual([]);
    });

    it("打开前文件被换成另一普通文件时拒绝交付", async () => {
        const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
        const source = join(allowed, "media.bin");
        const replacement = join(allowed, "next.bin");
        const moved = join(allowed, "moved.bin");
        await writeFile(source, "original");
        await writeFile(replacement, "replacement");
        vi.mocked(open).mockImplementationOnce(async (path, flags, mode) => {
            await rename(source, moved);
            await rename(replacement, source);
            return await fs.open(path, flags, mode);
        });

        await expectDenied(source);

        expect(await readFile(moved, "utf8")).toBe("original");
        expect(await readFile(source, "utf8")).toBe("replacement");
        await expect(lstat(replacement)).rejects.toMatchObject({ code: "ENOENT" });
    });
});
