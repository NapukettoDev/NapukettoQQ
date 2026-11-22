/**
 * 发送媒体 URI 解析（Milky OutgoingSegment uri → 本地路径）
 *
 * 规范支持 file:// / http(s):// / base64:// 三种（image/record/video 共用）：
 *  - file:// 和裸路径 → 核验授权后复制进动作缓存
 *  - base64:// → 解码落盘 cacheDir/milky/，file-type 探测扩展名后改名
 *  - http(s):// → 按媒体出站策略下载落盘 cacheDir/milky/
 * 未配置 mediaDir 时远程 URI 报错（不发静默空消息）。
 */

import { rename, writeFile } from "node:fs/promises";
import { kernelError } from "@napuketto/kernel";
import { detectFileType, inferExtension, type MediaOutboundPolicy } from "@napuketto/media";
import { resolveLocalMedia } from "../../../internal/infra/local-media.js";
import { cacheMediaFile } from "../../../internal/infra/media-cache.js";
import { mediaDownloader } from "../../../internal/qq/media.js";

const HTTP_URL_RE = /^https?:\/\//i;
const DETECTED_EXTENSION_RE = /^[a-zA-Z0-9]+$/;

/** 解析远程媒体 URI 为本地绝对路径（base64:// / http(s)://；file:// 走同步面）。 */
export async function resolveMediaUri(
    uri: string,
    mediaDir: string | undefined,
    outboundPolicy?: MediaOutboundPolicy,
): Promise<string> {
    if (mediaDir === undefined || mediaDir === "") {
        throw kernelError(
            "远程媒体发送需要配置 [accounts.milky] cacheDir（下载缓存目录）",
            "INVALID_PARAM",
        );
    }
    if (uri.startsWith("base64://")) {
        return await writeBase64(uri.slice("base64://".length), mediaDir);
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
    if (HTTP_URL_RE.test(uri) || uri.startsWith("base64://")) {
        return await resolveMediaUri(uri, mediaDir, outboundPolicy);
    }
    return await resolveLocalMedia(uri, localMediaRoots);
}

/** base64 载荷 → 落盘（先写 .bin，探测到扩展名再改名）。 */
async function writeBase64(payload: string, mediaDir: string): Promise<string> {
    let bytes: Buffer;
    try {
        bytes = Buffer.from(payload, "base64");
    } catch {
        throw kernelError("base64:// 载荷解码失败", "INVALID_PARAM");
    }
    if (bytes.length === 0) {
        throw kernelError("base64:// 载荷为空", "INVALID_PARAM");
    }
    return await cacheMediaFile(mediaDir, ".bin", async (raw) => {
        await writeFile(raw, bytes, { flag: "wx" });
        let ext: string;
        try {
            ({ ext } = await detectFileType(raw));
        } catch {
            // 类型探测失败：保留 .bin（QQ 端按内容嗅探）
            return raw;
        }
        if (!DETECTED_EXTENSION_RE.test(ext)) return raw;
        const final = `${raw.slice(0, -4)}.${ext}`;
        if (final !== raw) await rename(raw, final);
        return final;
    });
}
