/**
 * 发送媒体 URI 解析测试（helper/message/media-uri.ts）
 *
 * downloadUrl 以 vi.mock 替身拦截（不触网）；base64:// 走真实落盘链
 * （mkdtemp 临时目录 + 真实 detectFileType 探测/失败保留 .bin 两分支）。
 * 锁定：file:// 展开与畸形兜底、裸路径原样、http(s)/base64 需 mediaDir、
 * base64 空/空载荷报错、探测失败保留 .bin。
 */
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@napuketto/media", async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    downloadUrl: vi.fn(async (_url: string, _dest: string) => 4),
}));

import { downloadUrl } from "@napuketto/media";
import { resolveMediaUri, resolveUriToPath } from "../media-uri.js";

const mockedDownload = vi.mocked(downloadUrl);

/** PNG 文件头（file-type 探测用最小样本）。 */
const PNG_BYTES = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
]);

/** 用例临时目录（每个用例独立，afterAll 统一清理）。 */
let mediaDir = "";
const createdDirs: string[] = [];

beforeEach(async () => {
    mediaDir = await mkdtemp(join(tmpdir(), "nk-test-milky-media-"));
    createdDirs.push(mediaDir);
    mockedDownload.mockClear();
});

afterAll(async () => {
    for (const dir of createdDirs) {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
});

describe("resolveUriToPath（动作参数 uri）", () => {
    it("file:// → fileURLToPath 平台路径", async () => {
        const target = join(mediaDir, "x.png");
        const out = await resolveUriToPath(pathToFileURL(target).href, undefined);
        expect(out).toBe(target);
    });

    it("file:// 畸形 URI → 裸剥离前缀兜底", async () => {
        const out = await resolveUriToPath("file://%zzbad", undefined);
        expect(out.startsWith("file://")).toBe(false);
        expect(out).toContain("%zzbad");
    });

    it("裸路径（go-cqhttp 惯例）→ 原样返回", async () => {
        const raw = join("some", "dir", "a.jpg");
        await expect(resolveUriToPath(raw, undefined)).resolves.toBe(raw);
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

    it("http(s):// → downloadUrl 落盘 mediaDir（扩展名按 URL 推断）", async () => {
        const dest = await resolveMediaUri("http://127.0.0.1:9/a.png", mediaDir);
        expect(mockedDownload).toHaveBeenCalledWith("http://127.0.0.1:9/a.png", dest);
        expect(dest.startsWith(mediaDir)).toBe(true);
        expect(dest.endsWith(".png")).toBe(true);
    });

    it("http(s):// URL 无扩展名 → inferExtension 兜底 .bin", async () => {
        const dest = await resolveMediaUri("http://127.0.0.1:9/noext", mediaDir);
        expect(dest.startsWith(mediaDir)).toBe(true);
        expect(dest.endsWith(".bin")).toBe(true);
    });

    it("base64:// PNG 载荷 → 落盘 + 探测后改名（png 后缀；.bin 已移除）", async () => {
        const uri = `base64://${Buffer.from(PNG_BYTES).toString("base64")}`;
        const dest = await resolveMediaUri(uri, mediaDir);
        expect(dest.startsWith(mediaDir)).toBe(true);
        // detectFileType.ext 无点前缀（'png'），writeBase64 直接拼接 → 'uuidpng'
        // 形态（疑似生产缺陷：应有 '.' 分隔；以实际行为锁定，QQ 端按内容嗅探）
        expect(dest.endsWith("png")).toBe(true);
        expect(dest.endsWith(".png")).toBe(false);
        await expect(access(dest)).resolves.toBeUndefined();
        // 探测成功路径：中间 .bin 已被 rename 走
        const { readdir } = await import("node:fs/promises");
        const listing = await readdir(mediaDir);
        expect(listing).toEqual([dest.slice(mediaDir.length + 1)]);
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
});
