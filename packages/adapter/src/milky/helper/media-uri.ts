/**
 * 发送媒体 URI 解析（Milky OutgoingSegment uri → 本地路径）
 *
 * 规范支持 file:// / http(s):// / base64:// 三种（image/record/video 共用）：
 *  - file:// → 平台路径（segments.ts 的同步面已处理）
 *  - base64:// → 解码落盘 cacheDir/milky/，file-type 探测扩展名后改名
 *  - http(s):// → @napuketto/media downloadUrl 落盘 cacheDir/milky/
 * 未配置 mediaDir 时远程 URI 报错（不发静默空消息）。
 */

import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { kernelError } from "@napuketto/kernel";
import { detectFileType, downloadUrl, inferExtension } from "@napuketto/media";

/** 解析远程媒体 URI 为本地绝对路径（base64:// / http(s)://；file:// 走同步面）。 */
export async function resolveMediaUri(uri: string, mediaDir: string | undefined): Promise<string> {
    if (mediaDir === undefined || mediaDir === "") {
        throw kernelError(
            "远程媒体发送需要配置 [accounts.milky] cacheDir（下载缓存目录）",
            "INVALID_PARAM",
        );
    }
    if (uri.startsWith("base64://")) {
        return await writeBase64(uri.slice("base64://".length), mediaDir);
    }
    const dest = join(mediaDir, `${randomUUID()}${inferExtension(null, uri)}`);
    await downloadUrl(uri, dest);
    return dest;
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
    await mkdir(mediaDir, { recursive: true });
    const raw = join(mediaDir, `${randomUUID()}.bin`);
    await writeFile(raw, bytes);
    try {
        const { ext } = await detectFileType(raw);
        const final = join(mediaDir, `${randomUUID()}${ext}`);
        await rename(raw, final);
        return final;
    } catch {
        // 类型探测失败：保留 .bin（QQ 端按内容嗅探）
        return raw;
    }
}
