/**
 * 发送媒体 URI 解析（Milky OutgoingSegment uri → 本地路径）
 *
 * 规范支持 file:// / http(s):// / base64:// 三种（image/record/video 共用）：
 *  - file:// 和裸路径 → 核验授权后复制进动作缓存
 *  - base64:// → 解码落盘 cacheDir/milky/，file-type 探测扩展名后改名
 *  - http(s):// → 按媒体出站策略下载落盘 cacheDir/milky/
 * 未配置 mediaDir 时远程 URI 报错（不发静默空消息）。
 */

import { open, rename } from "node:fs/promises";
import { kernelError } from "@napuketto/kernel";
import { detectFileType, inferExtension, type MediaOutboundPolicy } from "@napuketto/media";
import { mediaDownloader } from "../../../internal/domain/media.js";
import { resolveLocalMedia } from "../../../internal/infra/local-media.js";
import { cacheMediaFile } from "../../../internal/infra/media-cache.js";

const HTTP_URL_RE = /^https?:\/\//i;
const DETECTED_EXTENSION_RE = /^[a-zA-Z0-9]+$/;
const BASE64_SCHEME = "base64://";
const MAX_DATA_BYTES = 30 * 1024 * 1024;
const MAX_BASE64_CHARS = Math.ceil(MAX_DATA_BYTES / 3) * 4;
const BASE64_CHUNK_CHARS = 64 * 1024;
const INVALID_BASE64_CHAR = /[^a-zA-Z0-9+/_-]/;

/** 解析远程媒体 URI 为本地绝对路径（base64:// / http(s)://；file:// 走同步面）。 */
export async function resolveMediaUri(
    uri: string,
    mediaDir: string | undefined,
    outboundPolicy?: MediaOutboundPolicy,
    signal?: AbortSignal,
): Promise<string> {
    if (mediaDir === undefined || mediaDir === "") {
        throw kernelError(
            "远程媒体发送需要配置 [accounts.milky] cacheDir（下载缓存目录）",
            "INVALID_PARAM",
        );
    }
    if (uri.startsWith(BASE64_SCHEME)) {
        return await writeBase64(uri, mediaDir, signal);
    }
    return await cacheMediaFile(mediaDir, inferExtension(null, uri), async (dest) => {
        await mediaDownloader(outboundPolicy)(uri, dest);
    });
}

/** 发送段与上传类动作共用相同的 URI 授权与下载规则。 */
export async function resolveUriToPath(
    uri: string,
    mediaDir: string | undefined,
    outboundPolicy?: MediaOutboundPolicy,
    localMediaRoots?: readonly string[],
): Promise<string> {
    if (HTTP_URL_RE.test(uri) || uri.startsWith(BASE64_SCHEME)) {
        return await resolveMediaUri(uri, mediaDir, outboundPolicy);
    }
    return await resolveLocalMedia(uri, localMediaRoots);
}

/** base64 载荷 → 落盘（先写 .bin，探测到扩展名再改名）。 */
async function writeBase64(uri: string, mediaDir: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const start = BASE64_SCHEME.length;
    const length = uri.length - start;
    if (length > MAX_BASE64_CHARS) throw kernelError("base64:// 编码载荷超出限制", "INVALID_PARAM");
    const padding = uri.endsWith("==") ? 2 : uri.endsWith("=") ? 1 : 0;
    const chars = length - padding;
    const tail = chars % 4;
    if (chars < 2 || tail === 1 || (padding !== 0 && tail + padding !== 4)) {
        throw kernelError("base64:// 载荷长度或填充无效", "INVALID_PARAM");
    }
    const expectedBytes = Math.floor((chars * 3) / 4);
    if (expectedBytes > MAX_DATA_BYTES)
        throw kernelError("base64:// 解码媒体超出限制", "INVALID_PARAM");
    return await cacheMediaFile(mediaDir, ".bin", async (raw) => {
        await writeBase64Chunks(raw, uri, start + chars, expectedBytes, signal);
        const type = await detectFileType(raw, { signal }).catch(() => undefined);
        signal?.throwIfAborted();
        if (type === undefined) {
            // 类型探测失败：保留 .bin（QQ 端按内容嗅探）
            return raw;
        }
        const { ext } = type;
        if (!DETECTED_EXTENSION_RE.test(ext)) return raw;
        const final = `${raw.slice(0, -4)}.${ext}`;
        if (final !== raw) await rename(raw, final);
        return final;
    });
}

async function writeBase64Chunks(
    path: string,
    uri: string,
    end: number,
    expectedBytes: number,
    signal?: AbortSignal,
): Promise<void> {
    signal?.throwIfAborted();
    const handle = await open(path, "wx", 0o600);
    try {
        let written = 0;
        for (let offset = BASE64_SCHEME.length; offset < end; offset += BASE64_CHUNK_CHARS) {
            signal?.throwIfAborted();
            const chunk = uri.slice(offset, Math.min(offset + BASE64_CHUNK_CHARS, end));
            if (INVALID_BASE64_CHAR.test(chunk))
                throw kernelError("base64:// 载荷包含无效字符", "INVALID_PARAM");
            const bytes = Buffer.from(chunk, "base64");
            written += bytes.byteLength;
            if (written > MAX_DATA_BYTES)
                throw kernelError("base64:// 解码媒体超出限制", "INVALID_PARAM");
            await handle.writeFile(bytes);
        }
        if (written !== expectedBytes) throw kernelError("base64:// 解码长度无效", "INVALID_PARAM");
    } finally {
        await handle.close();
    }
}
