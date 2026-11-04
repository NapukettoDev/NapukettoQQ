/**
 * image.ts 测试（内联字节夹具，不提交二进制文件）
 *
 * getImageSize：PNG / GIF / WebP 魔数解析宽高、非图片文件报错；
 * detectFileType：file-type 魔数识别（png / gif / webp）、无法识别 → MediaError。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectFileType, getImageSize } from "../image.js";
import { MediaError } from "../types.js";

/** 1x1 PNG（公开的标准最小 PNG 字节，base64 内联）。 */
const PNG_1X1 = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
);

/** 最小 GIF89a 头：1x1 + 全局色表标志（image-size 只读头部即可解析）。 */
const GIF_1X1 = Uint8Array.from([
    0x47,
    0x49,
    0x46,
    0x38,
    0x39,
    0x61, // "GIF89a"
    0x01,
    0x00, // 逻辑屏幕宽 = 1（LE16）
    0x01,
    0x00, // 逻辑屏幕高 = 1（LE16）
    0x80,
    0x00,
    0x00, // packed（全局色表）/ 背景色 / 宽高比
]);

/** 最小 WebP（VP8X 扩展格式块）：2x3 画布。 */
const WEBP_VP8X_2X3 = Uint8Array.from([
    0x52,
    0x49,
    0x46,
    0x46, // "RIFF"
    0x1a,
    0x00,
    0x00,
    0x00, // RIFF 块长 = 26
    0x57,
    0x45,
    0x42,
    0x50, // "WEBP"
    0x56,
    0x50,
    0x38,
    0x58, // "VP8X"
    0x0a,
    0x00,
    0x00,
    0x00, // VP8X 载荷长 = 10
    0x00,
    0x00,
    0x00,
    0x00, // flags / reserved
    0x01,
    0x00,
    0x00, // 画布宽-1 = 1 → 2（LE24）
    0x02,
    0x00,
    0x00, // 画布高-1 = 2 → 3（LE24）
]);

describe("getImageSize", () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "nk-media-img-"));
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it("PNG → 宽高 1x1", async () => {
        const file = join(dir, "a.png");
        writeFileSync(file, PNG_1X1);

        expect(await getImageSize(file)).toEqual({ width: 1, height: 1 });
    });

    it("GIF → 宽高 1x1", async () => {
        const file = join(dir, "a.gif");
        writeFileSync(file, GIF_1X1);

        expect(await getImageSize(file)).toEqual({ width: 1, height: 1 });
    });

    it("WebP（VP8X）→ 宽高 2x3", async () => {
        const file = join(dir, "a.webp");
        writeFileSync(file, WEBP_VP8X_2X3);

        expect(await getImageSize(file)).toEqual({ width: 2, height: 3 });
    });

    it("非图片文件 → 抛错（不静默返回 0）", async () => {
        const file = join(dir, "a.txt");
        writeFileSync(file, "plain text, not an image");

        await expect(getImageSize(file)).rejects.toThrow();
    });
});

describe("detectFileType", () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "nk-media-ft-"));
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it("PNG → ext png / mime image/png", async () => {
        const file = join(dir, "a.png");
        writeFileSync(file, PNG_1X1);

        expect(await detectFileType(file)).toEqual({ ext: "png", mime: "image/png" });
    });

    it("GIF → ext gif / mime image/gif", async () => {
        const file = join(dir, "a.gif");
        writeFileSync(file, GIF_1X1);

        expect(await detectFileType(file)).toEqual({ ext: "gif", mime: "image/gif" });
    });

    it("WebP → ext webp / mime image/webp", async () => {
        const file = join(dir, "a.webp");
        writeFileSync(file, WEBP_VP8X_2X3);

        expect(await detectFileType(file)).toEqual({ ext: "webp", mime: "image/webp" });
    });

    it("纯文本 → MediaError（无法识别的文件类型）", async () => {
        const file = join(dir, "a.txt");
        writeFileSync(file, "plain text");

        await expect(detectFileType(file)).rejects.toThrow(MediaError);
        await expect(detectFileType(file)).rejects.toThrow(/无法识别的文件类型/);
    });

    it("空文件 → MediaError", async () => {
        const file = join(dir, "empty.bin");
        writeFileSync(file, Buffer.alloc(0));

        await expect(detectFileType(file)).rejects.toThrow(MediaError);
    });
});
