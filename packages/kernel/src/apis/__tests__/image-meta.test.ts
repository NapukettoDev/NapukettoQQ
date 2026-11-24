/**
 * image-meta.ts 单测：零依赖文件头探测 + picType 映射。
 *
 * 覆盖 PNG / GIF / BMP / WebP（VP8、VP8L、VP8X）/ JPEG（SOF0、SOF2）头部、
 * 非图片与不可读文件的安全降级，以及 `resolvePicType` 的全部分支。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { probeImageMetaFallback, resolvePicType } from "../image-meta.js";

/** PNG：8 字节签名 + IHDR（宽高为大端 uint32）。 */
function png(width: number, height: number): Buffer {
    const buf = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
    buf.writeUInt32BE(13, 8);
    buf.write("IHDR", 12, "ascii");
    buf.writeUInt32BE(width, 16);
    buf.writeUInt32BE(height, 20);
    buf[24] = 8; // bit depth
    buf[25] = 6; // color type: RGBA
    return buf;
}

/** GIF：GIF89a 头 + 小端 uint16 逻辑屏幕宽高。 */
function gif(width: number, height: number): Buffer {
    const buf = Buffer.alloc(13);
    buf.write("GIF89a", 0, "ascii");
    buf.writeUInt16LE(width, 6);
    buf.writeUInt16LE(height, 8);
    return buf;
}

/** BMP：14 字节文件头 + 40 字节 BITMAPINFOHEADER（高度可为负）。 */
function bmp(width: number, height: number): Buffer {
    const buf = Buffer.alloc(54);
    buf.write("BM", 0, "ascii");
    buf.writeUInt32LE(54, 2);
    buf.writeUInt32LE(40, 14);
    buf.writeInt32LE(width, 18);
    buf.writeInt32LE(height, 22);
    buf.writeUInt16LE(1, 26);
    buf.writeUInt16LE(24, 28);
    return buf;
}

/** WebP 有损（VP8）：RIFF 容器 + 起始码 9D 01 2A + 14 位宽高。 */
function webpVp8(width: number, height: number): Buffer {
    const buf = Buffer.alloc(30);
    buf.write("RIFF", 0, "ascii");
    buf.writeUInt32LE(22, 4);
    buf.write("WEBP", 8, "ascii");
    buf.write("VP8 ", 12, "ascii");
    buf.writeUInt32LE(10, 16);
    buf[23] = 0x9d;
    buf[24] = 0x01;
    buf[25] = 0x2a;
    buf.writeUInt16LE(width, 26);
    buf.writeUInt16LE(height, 28);
    return buf;
}

/** WebP 无损（VP8L）：0x2F 签名 + 14 位宽高（均减 1 存储）。 */
function webpVp8l(width: number, height: number): Buffer {
    const buf = Buffer.alloc(25);
    buf.write("RIFF", 0, "ascii");
    buf.writeUInt32LE(17, 4);
    buf.write("WEBP", 8, "ascii");
    buf.write("VP8L", 12, "ascii");
    buf.writeUInt32LE(10, 16);
    buf[20] = 0x2f;
    buf.writeUInt32LE((height - 1) * 0x4000 + (width - 1), 21);
    return buf;
}

/** WebP 扩展（VP8X）：24 位小端画布宽高（均减 1 存储）。 */
function webpVp8x(width: number, height: number): Buffer {
    const buf = Buffer.alloc(30);
    buf.write("RIFF", 0, "ascii");
    buf.writeUInt32LE(22, 4);
    buf.write("WEBP", 8, "ascii");
    buf.write("VP8X", 12, "ascii");
    buf.writeUInt32LE(10, 16);
    buf.writeUIntLE(width - 1, 24, 3);
    buf.writeUIntLE(height - 1, 27, 3);
    return buf;
}

/** JPEG：SOI + APP0 + 指定 SOF marker（高度/宽度为大端 uint16）。 */
function jpeg(width: number, height: number, sof = 0xc0): Buffer {
    const app0 = Buffer.alloc(18);
    app0[0] = 0xff;
    app0[1] = 0xe0;
    app0.writeUInt16BE(16, 2);
    app0.write("JFIF\0", 4, "ascii");
    const frame = Buffer.alloc(19);
    frame[0] = 0xff;
    frame[1] = sof;
    frame.writeUInt16BE(17, 2);
    frame[4] = 8; // precision
    frame.writeUInt16BE(height, 5);
    frame.writeUInt16BE(width, 7);
    frame[9] = 3; // components
    return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, frame]);
}

describe("probeImageMetaFallback", () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "napuketto-image-meta-"));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    function write(name: string, content: Buffer): string {
        const path = join(dir, name);
        writeFileSync(path, content);
        return path;
    }

    it.each([
        {
            name: "png",
            content: png(640, 480),
            expected: { width: 640, height: 480, mime: "image/png" },
        },
        {
            name: "gif",
            content: gif(320, 240),
            expected: { width: 320, height: 240, mime: "image/gif" },
        },
        {
            name: "bmp",
            content: bmp(800, 600),
            expected: { width: 800, height: 600, mime: "image/bmp" },
        },
        {
            name: "bmp-top-down",
            content: bmp(96, -48),
            expected: { width: 96, height: 48, mime: "image/bmp" },
        },
        {
            name: "webp-vp8",
            content: webpVp8(1024, 768),
            expected: { width: 1024, height: 768, mime: "image/webp" },
        },
        {
            name: "webp-vp8l",
            content: webpVp8l(500, 300),
            expected: { width: 500, height: 300, mime: "image/webp" },
        },
        {
            name: "webp-vp8x",
            content: webpVp8x(1920, 1080),
            expected: { width: 1920, height: 1080, mime: "image/webp" },
        },
        {
            name: "jpeg-sof0",
            content: jpeg(400, 300),
            expected: { width: 400, height: 300, mime: "image/jpeg" },
        },
        {
            name: "jpeg-sof2",
            content: jpeg(1200, 900, 0xc2),
            expected: { width: 1200, height: 900, mime: "image/jpeg" },
        },
    ])("解析 $name 头部", async ({ name, content, expected }) => {
        await expect(probeImageMetaFallback(write(name, content))).resolves.toEqual(expected);
    });

    it("非图片内容（无魔数）→ 空对象", async () => {
        await expect(
            probeImageMetaFallback(write("note.txt", Buffer.from("not an image at all"))),
        ).resolves.toEqual({});
    });

    it("空文件 → 空对象", async () => {
        await expect(probeImageMetaFallback(write("empty.png", Buffer.alloc(0)))).resolves.toEqual(
            {},
        );
    });

    it("文件不存在 → 空对象（不抛错）", async () => {
        await expect(probeImageMetaFallback(join(dir, "missing.png"))).resolves.toEqual({});
    });

    it("目录路径 → 空对象（不抛错）", async () => {
        await expect(probeImageMetaFallback(dir)).resolves.toEqual({});
    });

    it("PNG 签名但尺寸为零 → 只返回 MIME", async () => {
        await expect(probeImageMetaFallback(write("zero.png", png(0, 0)))).resolves.toEqual({
            mime: "image/png",
        });
    });

    it("截断的 JPEG（无 SOF）→ 只返回 MIME", async () => {
        const truncated = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
        await expect(probeImageMetaFallback(write("truncated.jpg", truncated))).resolves.toEqual({
            mime: "image/jpeg",
        });
    });
});

describe("resolvePicType", () => {
    const cases: ReadonlyArray<{
        mime: string | undefined;
        path: string | undefined;
        expected: number;
    }> = [
        { mime: "image/png", path: undefined, expected: 1001 },
        { mime: "image/webp", path: undefined, expected: 1002 },
        { mime: "image/bmp", path: undefined, expected: 1005 },
        { mime: "image/gif", path: undefined, expected: 2000 },
        { mime: "image/jpeg", path: undefined, expected: 1000 },
        { mime: undefined, path: "/tmp/a.png", expected: 1001 },
        { mime: undefined, path: "/tmp/a.PNG", expected: 1001 },
        { mime: undefined, path: "/tmp/a.webp", expected: 1002 },
        { mime: undefined, path: "/tmp/a.bmp", expected: 1005 },
        { mime: undefined, path: "/tmp/a.gif", expected: 2000 },
        { mime: undefined, path: "/tmp/a.jpg", expected: 1000 },
        { mime: undefined, path: "/tmp/a.jpeg", expected: 1000 },
    ];
    it.each(cases)("mime=$mime path=$path → $expected", ({ mime, path, expected }) => {
        expect(resolvePicType(mime, path)).toBe(expected);
    });

    it("MIME 大小写/空白归一化；MIME 优先于扩展名", () => {
        expect(resolvePicType("  IMAGE/PNG ", "/tmp/a.jpg")).toBe(1001);
        expect(resolvePicType("image/gif", "/tmp/a.png")).toBe(2000);
    });

    it("未知 MIME / 未知扩展名 / 空值 → JPG 兜底 1000", () => {
        expect(resolvePicType("image/heic", "/tmp/a.heic")).toBe(1000);
        expect(resolvePicType("application/octet-stream", "/tmp/a.bin")).toBe(1000);
        expect(resolvePicType("", "")).toBe(1000);
        expect(resolvePicType()).toBe(1000);
    });

    it("非字符串 MIME（IPC 脏值）→ 按扩展名兜底，不抛错", () => {
        expect(resolvePicType(42 as unknown as string, "/tmp/a.png")).toBe(1001);
        expect(resolvePicType(42 as unknown as string)).toBe(1000);
    });

    it("MIME 未知时仍尝试扩展名", () => {
        expect(resolvePicType("image/heic", "/tmp/a.png")).toBe(1001);
    });
});
