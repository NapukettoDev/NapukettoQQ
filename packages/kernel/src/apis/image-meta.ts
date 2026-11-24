/**
 * 图片发送元数据：NTQQ picType 映射 + 零依赖文件头探测兜底。
 *
 * kernel 不依赖 `@napuketto/media`（解耦红线）：adapter 已探测的 canonical
 * `size` / `mime` 优先；缺失时（IPC 直发、第三方直接调 kernel）由本模块读取
 * 文件头补齐宽高与 MIME，让 picElement 的 picWidth / picHeight / picType
 * 反映真实图片，而不是固定占位值（0 / 0 / 1000 会让手机端显示空白）。
 *
 * 探测只读前 64 KiB 且失败静默返回 `{}`：元数据不是发送成功的前置条件，
 * 不能因为解析失败阻断消息。
 */
import { type FileHandle, open } from "node:fs/promises";
import { extname } from "node:path";

/** 只读文件头：PNG/GIF/BMP/WebP/JPEG 的尺寸与 MIME 都在前 64 KiB 内。 */
const PROBE_HEAD_BYTES = 64 * 1024;

/** NTQQ picType：JPG / 未知兜底。 */
const PIC_TYPE_JPEG = 1000;

/** NTQQ picType 枚举（按 MIME 映射）。 */
const PIC_TYPE_BY_MIME: Readonly<Record<string, number>> = {
    "image/jpeg": PIC_TYPE_JPEG,
    "image/jpg": PIC_TYPE_JPEG,
    "image/pjpeg": PIC_TYPE_JPEG,
    "image/png": 1001,
    "image/webp": 1002,
    "image/bmp": 1005,
    "image/x-ms-bmp": 1005,
    "image/gif": 2000,
};

/** NTQQ picType 枚举（MIME 缺失/未知时按扩展名兜底）。 */
const PIC_TYPE_BY_EXTENSION: Readonly<Record<string, number>> = {
    ".jpg": PIC_TYPE_JPEG,
    ".jpeg": PIC_TYPE_JPEG,
    ".png": 1001,
    ".webp": 1002,
    ".bmp": 1005,
    ".gif": 2000,
};

/** 文件头探测结果：解析失败的字段缺省（不抛错）。 */
export interface ImageMeta {
    width?: number;
    height?: number;
    mime?: string;
}

/** PNG 魔数（`\x89PNG\r\n\x1a\n`）。 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** JPEG SOI（`0xFFD8`）。 */
const JPEG_SOI = 0xffd8;

/** JPEG 帧起始段：SOF0 基线 / SOF1 扩展 / SOF2 渐进。 */
const JPEG_SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2]);

/** 正整数校验（0 / 负数 / 非安全整数均视为缺失）。 */
function validDimension(value: number | undefined): value is number {
    return value !== undefined && Number.isSafeInteger(value) && value > 0;
}

/** 组装探测结果：宽高必须同时有效，否则只返回 MIME。 */
function meta(mime: string, width?: number, height?: number): ImageMeta {
    return validDimension(width) && validDimension(height) ? { mime, width, height } : { mime };
}

/** PNG：IHDR 固定位于签名后，宽高为大端 uint32。 */
function parsePng(head: Buffer): ImageMeta | null {
    if (head.length < 24 || !head.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
        return null;
    }
    return meta("image/png", head.readUInt32BE(16), head.readUInt32BE(20));
}

/** GIF87a / GIF89a：逻辑屏幕宽高为小端 uint16。 */
function parseGif(head: Buffer): ImageMeta | null {
    if (head.length < 10) {
        return null;
    }
    const signature = head.subarray(0, 6).toString("ascii");
    if (signature !== "GIF87a" && signature !== "GIF89a") {
        return null;
    }
    return meta("image/gif", head.readUInt16LE(6), head.readUInt16LE(8));
}

/** BMP：按 DIB 头大小区分 BITMAPCOREHEADER(12) 与后续 32 位头。 */
function parseBmp(head: Buffer): ImageMeta | null {
    if (head.length < 18 || head.subarray(0, 2).toString("ascii") !== "BM") {
        return null;
    }
    const headerSize = head.readUInt32LE(14);
    if (headerSize === 12) {
        if (head.length < 22) {
            return meta("image/bmp");
        }
        return meta("image/bmp", head.readUInt16LE(18), head.readUInt16LE(20));
    }
    if (head.length < 26) {
        return meta("image/bmp");
    }
    // 高度为负表示自上而下存储，取绝对值。
    return meta("image/bmp", head.readInt32LE(18), Math.abs(head.readInt32LE(22)));
}

/** WebP：RIFF 容器内的 VP8（有损）/ VP8L（无损）/ VP8X（扩展）三种布局。 */
function parseWebp(head: Buffer): ImageMeta | null {
    if (
        head.length < 16 ||
        head.subarray(0, 4).toString("ascii") !== "RIFF" ||
        head.subarray(8, 12).toString("ascii") !== "WEBP"
    ) {
        return null;
    }
    const chunk = head.subarray(12, 16).toString("ascii");
    if (
        chunk === "VP8 " &&
        head.length >= 30 &&
        head.readUInt8(23) === 0x9d &&
        head.readUInt8(24) === 0x01 &&
        head.readUInt8(25) === 0x2a
    ) {
        // 有损：起始码 9D 01 2A 后紧跟 14 位宽、14 位高。
        return meta("image/webp", head.readUInt16LE(26) & 0x3fff, head.readUInt16LE(28) & 0x3fff);
    }
    if (chunk === "VP8L" && head.length >= 25 && head.readUInt8(20) === 0x2f) {
        // 无损：0x2F 签名后 4 字节小端位域（14 位宽 / 14 位高，均减 1 存储）。
        const bits = head.readUInt32LE(21);
        return meta("image/webp", 1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff));
    }
    if (chunk === "VP8X" && head.length >= 30) {
        // 扩展：24 位小端画布宽高（减 1 存储）。
        return meta("image/webp", 1 + head.readUIntLE(24, 3), 1 + head.readUIntLE(27, 3));
    }
    return meta("image/webp");
}

/** 跳过 marker 前的连续 0xFF 填充；越界返回 null。 */
function skipJpegFill(head: Buffer, start: number): number | null {
    let cursor = start;
    while (cursor < head.length && head.readUInt8(cursor) === 0xff) {
        cursor += 1;
    }
    return cursor >= head.length ? null : cursor;
}

/** 无长度字段的独立 marker：SOI / TEM / EOI / RSTn。 */
function isJpegStandaloneMarker(marker: number): boolean {
    return (
        marker === 0xd8 || marker === 0x01 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)
    );
}

/** 读取段长度（含自身 2 字节）；越界或非法返回 null。 */
function jpegSegmentLength(head: Buffer, lengthOffset: number): number | null {
    if (lengthOffset + 2 > head.length) {
        return null;
    }
    const length = head.readUInt16BE(lengthOffset);
    return length < 2 ? null : length;
}

/** 读取 SOF 段宽高（段布局：长度(2) 精度(1) 高(2) 宽(2)）；段不完整返回 null。 */
function jpegFrameSize(
    head: Buffer,
    lengthOffset: number,
): { width: number; height: number } | null {
    if (lengthOffset + 7 > head.length) {
        return null;
    }
    return {
        width: head.readUInt16BE(lengthOffset + 5),
        height: head.readUInt16BE(lengthOffset + 3),
    };
}

/** JPEG 单步扫描结果：命中 SOF / 跳到下一段 / 无法继续。 */
type JpegStep =
    | { kind: "frame"; width: number; height: number }
    | { kind: "next"; offset: number }
    | { kind: "stop" };

/** 从 offset 扫描一个 JPEG 段。 */
function jpegStep(head: Buffer, offset: number): JpegStep {
    if (head.readUInt8(offset) !== 0xff) {
        return { kind: "next", offset: offset + 1 };
    }
    const markerStart = skipJpegFill(head, offset + 1);
    if (markerStart === null) {
        return { kind: "stop" };
    }
    const marker = head.readUInt8(markerStart);
    if (isJpegStandaloneMarker(marker)) {
        return { kind: "next", offset: markerStart + 1 };
    }
    if (marker === 0xda) {
        // 进入熵编码数据，尺寸不可能在此之后。
        return { kind: "stop" };
    }
    const lengthOffset = markerStart + 1;
    const length = jpegSegmentLength(head, lengthOffset);
    if (length === null) {
        return { kind: "stop" };
    }
    if (JPEG_SOF_MARKERS.has(marker)) {
        const frame = jpegFrameSize(head, lengthOffset);
        return frame === null ? { kind: "stop" } : { kind: "frame", ...frame };
    }
    return { kind: "next", offset: lengthOffset + length };
}

/** JPEG：扫描段表直到 SOF0/SOF1/SOF2 取宽高（尺寸总在 SOS 之前）。 */
function parseJpeg(head: Buffer): ImageMeta | null {
    if (head.length < 2 || head.readUInt16BE(0) !== JPEG_SOI) {
        return null;
    }
    let offset = 2;
    while (offset < head.length) {
        const step = jpegStep(head, offset);
        if (step.kind === "stop") {
            break;
        }
        if (step.kind === "frame") {
            return meta("image/jpeg", step.width, step.height);
        }
        offset = step.offset;
    }
    return meta("image/jpeg");
}

/** 读取文件头（最多 64 KiB）；打开/读取失败返回 null（静默降级）。 */
async function readHead(path: string): Promise<Buffer | null> {
    let handle: FileHandle;
    try {
        handle = await open(path, "r");
    } catch {
        return null;
    }
    try {
        const buffer = Buffer.alloc(PROBE_HEAD_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, PROBE_HEAD_BYTES, 0);
        return buffer.subarray(0, bytesRead);
    } catch {
        return null;
    } finally {
        await handle.close().catch(() => undefined);
    }
}

/** 按文件头识别格式（签名互斥；全部不匹配返回 null）。 */
function parseImageHead(head: Buffer): ImageMeta | null {
    return parsePng(head) ?? parseGif(head) ?? parseBmp(head) ?? parseWebp(head) ?? parseJpeg(head);
}

/**
 * 零依赖探测图片宽高与 MIME（PNG / GIF / BMP / WebP / JPEG 文件头）。
 *
 * 解析失败、文件不可读或格式未知一律返回 `{}`，绝不抛错。
 */
export async function probeImageMetaFallback(path: string): Promise<ImageMeta> {
    const head = await readHead(path);
    if (head === null || head.length === 0) {
        return {};
    }
    const parsed = parseImageHead(head);
    if (parsed === null) {
        return {};
    }
    const result: ImageMeta = {};
    if (parsed.mime !== undefined) {
        result.mime = parsed.mime;
    }
    if (validDimension(parsed.width)) {
        result.width = parsed.width;
    }
    if (validDimension(parsed.height)) {
        result.height = parsed.height;
    }
    return result;
}

/**
 * canonical MIME / 扩展名 → NTQQ picType。
 *
 * MIME 优先（明确告知类型），未知/缺失时看扩展名，仍未识别按 JPG（1000）
 * 兜底——与历史发送契约一致。
 */
export function resolvePicType(mime?: string, path?: string): number {
    const normalizedMime = typeof mime === "string" ? mime.trim().toLowerCase() : undefined;
    if (normalizedMime !== undefined && normalizedMime !== "") {
        const byMime = PIC_TYPE_BY_MIME[normalizedMime];
        if (byMime !== undefined) {
            return byMime;
        }
    }
    const extension = path === undefined ? "" : extname(path).toLowerCase();
    return PIC_TYPE_BY_EXTENSION[extension] ?? PIC_TYPE_JPEG;
}
