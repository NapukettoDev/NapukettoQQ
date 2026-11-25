/**
 * 发送媒体 URI 解析测试（helper/message/media-uri.ts）
 *
 * downloadPublicUrl 以 vi.mock 替身拦截（不触网）；base64:// 走真实落盘链
 * （mkdtemp 临时目录 + 真实 detectFileType 探测/失败保留 .bin 两分支）。
 * 锁定：file:// 与裸路径授权、畸形 URI 拒绝、http(s)/base64 需 mediaDir、
 * base64 空/空载荷报错、探测失败保留 .bin。
 */
import {
    access,
    mkdtemp,
    readdir,
    readFile,
    realpath,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@napuketto/media", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@napuketto/media")>();
    return {
        ...actual,
        detectFileType: vi.fn(actual.detectFileType),
        downloadPublicUrl: vi.fn(async (_url: string, dest: string) => {
            await writeFile(dest, "test");
            return 4;
        }),
    };
});

import { detectFileType, downloadPublicUrl } from "@napuketto/media";
import { withMediaScope } from "../../../../src/internal/infra/media-cache.js";
import {
    resolveMediaUri,
    resolveUriToPath,
} from "../../../../src/milky/helper/message/media-uri.js";

const mockedDownload = vi.mocked(downloadPublicUrl);

/** PNG 文件头（file-type 探测用最小样本）。 */
const PNG_BYTES = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
]);

/** 用例临时目录（每个用例独立，afterAll 统一清理）。 */
let mediaDir = "";
const createdDirs: string[] = [];

beforeEach(async () => {
    mediaDir = await realpath(await mkdtemp(join(tmpdir(), "nk-test-milky-media-")));
    createdDirs.push(mediaDir);
    mockedDownload.mockClear();
});

afterAll(async () => {
    for (const dir of createdDirs) {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
});

describe("resolveUriToPath（动作参数 uri）", () => {
    it("file:// 和裸路径从授权目录复制", async () => {
        const target = join(mediaDir, "x.png");
        await writeFile(target, "test");
        await withMediaScope(async () => {
            for (const uri of [pathToFileURL(target).href, "x.png"]) {
                const out = await resolveUriToPath(uri, undefined, undefined, [mediaDir]);
                expect(out).not.toBe(target);
                expect(await readFile(out, "utf8")).toBe("test");
            }
        });
    });

    it("畸形 file:// URI 拒绝", async () => {
        await expect(resolveUriToPath("file://%zzbad", undefined)).rejects.toMatchObject({
            code: "INVALID_PARAM",
        });
    });

    it("http(s)/base64 → 转发 resolveMediaUri（需 mediaDir）", async () => {
        await expect(resolveUriToPath("http://x.example/a.png", undefined)).rejects.toMatchObject({
            code: "INVALID_PARAM",
        });
        const httpDest = await resolveUriToPath("https://x.example/a.png", mediaDir);
        expect(httpDest.endsWith(".png")).toBe(true);
        expect(mockedDownload).toHaveBeenCalledTimes(1);
        const b64Dest = await resolveUriToPath("base64://aGVsbG8=", mediaDir);
        expect(b64Dest.endsWith(".bin")).toBe(true);
    });
});

describe("resolveMediaUri（远程媒体落盘）", () => {
    it("mediaDir 未配置 / 空串 → INVALID_PARAM（不发静默空消息）", async () => {
        await expect(resolveMediaUri("http://x/a.png", undefined)).rejects.toMatchObject({
            code: "INVALID_PARAM",
        });
        await expect(resolveMediaUri("http://x/a.png", "")).rejects.toMatchObject({
            code: "INVALID_PARAM",
        });
        expect(mockedDownload).not.toHaveBeenCalled();
    });

    it("http(s):// → downloadPublicUrl 落盘 mediaDir（扩展名按 URL 推断）", async () => {
        const dest = await resolveMediaUri("http://127.0.0.1:9/a.png", mediaDir);
        expect(mockedDownload).toHaveBeenCalledWith("http://127.0.0.1:9/a.png", dest);
        expect(dest).toContain(mediaDir);
        expect(dest.endsWith(".png")).toBe(true);
    });

    it("http(s):// URL 无扩展名 → inferExtension 兜底 .bin", async () => {
        const dest = await resolveMediaUri("http://127.0.0.1:9/noext", mediaDir);
        expect(dest).toContain(mediaDir);
        expect(dest.endsWith(".bin")).toBe(true);
    });

    it("base64:// PNG 载荷 → 落盘 + 探测后改名（png 后缀；.bin 已移除）", async () => {
        const uri = `base64://${Buffer.from(PNG_BYTES).toString("base64")}`;
        const dest = await resolveMediaUri(uri, mediaDir);
        expect(dest).toContain(mediaDir);
        expect(dest.endsWith(".png")).toBe(true);
        await expect(access(dest)).resolves.toBeUndefined();
        // 探测成功路径：中间 .bin 已被 rename 走
        const listing = await readdir(dirname(dest));
        expect(listing).toEqual([".owner.json", "media.png"]);
    });

    it("base64:// 无法探测的内容 → 保留 .bin（QQ 端按内容嗅探）", async () => {
        const uri = `base64://${Buffer.from("plain text not an image", "utf8").toString("base64")}`;
        const dest = await resolveMediaUri(uri, mediaDir);
        expect(dest.endsWith(".bin")).toBe(true);
        await expect(access(dest)).resolves.toBeUndefined();
    });

    it("base64:// 空载荷 → INVALID_PARAM", async () => {
        await expect(resolveMediaUri("base64://", mediaDir)).rejects.toMatchObject({
            code: "INVALID_PARAM",
        });
        await expect(resolveMediaUri("base64://%%%%", mediaDir)).rejects.toMatchObject({
            code: "INVALID_PARAM",
        });
    });

    it("30 MiB 解码边界可消费，超出编码上限时不分配条目", async () => {
        const uri = `base64://${"A".repeat(40 * 1024 * 1024)}`;
        await expect(resolveMediaUri(`${uri}AAAA`, mediaDir)).rejects.toMatchObject({
            code: "INVALID_PARAM",
        });
        expect(await readdir(mediaDir)).toEqual([]);
        let path = "";
        await withMediaScope(async () => {
            path = await resolveMediaUri(uri, mediaDir);
            expect((await stat(path)).size).toBe(30 * 1024 * 1024);
        });
        await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await readdir(dirname(dirname(path)))).toEqual([]);
    });

    it("URL-safe 省略填充可消费，动作失败后释放", async () => {
        let path = "";
        await expect(
            withMediaScope(async () => {
                path = await resolveMediaUri("base64://-_8", mediaDir);
                expect(await readFile(path)).toEqual(Buffer.from([0xfb, 0xff]));
                throw new Error("native test failure");
            }),
        ).rejects.toThrow("native test failure");
        await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("无效尾块和探测期间取消都清理已经写出的文件", async () => {
        const cacheRoot = join(mediaDir, ".napuketto-media-v1");
        await expect(
            resolveMediaUri(`base64://${"A".repeat(64 * 1024)}!AAA`, mediaDir),
        ).rejects.toMatchObject({
            code: "INVALID_PARAM",
        });
        expect(await readdir(cacheRoot)).toEqual([]);
        const controller = new AbortController();
        vi.mocked(detectFileType).mockImplementationOnce(async (file) => {
            expect((await stat(file)).size).toBe(5);
            controller.abort();
            return { ext: "png", mime: "image/png" };
        });
        await expect(
            withMediaScope(() =>
                resolveMediaUri("base64://aGVsbG8=", mediaDir, undefined, controller.signal),
            ),
        ).rejects.toMatchObject({ name: "AbortError" });
        expect(await readdir(cacheRoot)).toEqual([]);
    });
});
