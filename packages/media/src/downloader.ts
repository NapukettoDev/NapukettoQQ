/**
 * downloader.ts：HTTP(S) 媒体下载（2026-09-08 T5）
 *
 * 协议层（adapter get_image 主动下载 / koishi 插件发送侧下沉）共用的
 * 最小下载原语：fetch + 大小上限 + 超时，写目标路径（调用方管理目录与清理）。
 * 零额外依赖（Node 18+ 内建 fetch）。
 */

import { MediaError } from "./types.js";

/** 下载选项。 */
export interface DownloadUrlOptions {
    /** 超时毫秒（缺省 15s）。 */
    timeoutMs?: number;
    /** 大小上限字节（缺省 30MB）。 */
    maxBytes?: number;
}

/** 默认大小上限（30MB）。 */
const DEFAULT_MAX_BYTES = 30 * 1024 * 1024;

/** 默认超时（15s）。 */
const DEFAULT_TIMEOUT_MS = 15_000;

/** 扩展名字符合法性（URL pathname 提取校验）。 */
const EXT_RE = /^\.[a-z0-9]+$/i;

/**
 * 下载 URL 到目标路径（覆盖写）。返回写入字节数。
 * 失败抛错（非 2xx / 超限 / 超时 / 空 body / IO 错误），不产生半成品语义
 * （失败时目标文件可能残留，调用方负责清理目录）。
 */
export async function downloadUrl(
    url: string,
    dest: string,
    options: DownloadUrlOptions = {},
): Promise<number> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const response = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
        throw new MediaError(`HTTP ${response.status}`);
    }
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > maxBytes) {
        throw new MediaError(`文件超过大小上限（${declared} > ${maxBytes} 字节）`);
    }
    const body = response.body;
    if (body === null) {
        throw new MediaError("响应无 body");
    }
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        if (value === undefined) {
            continue;
        }
        total += value.byteLength;
        if (total > maxBytes) {
            await reader.cancel().catch(() => undefined);
            throw new MediaError(`文件超过大小上限（>${maxBytes} 字节）`);
        }
        chunks.push(value);
    }
    if (total === 0) {
        throw new MediaError("下载内容为空");
    }
    const { writeFile } = await import("node:fs/promises");
    await writeFile(dest, Buffer.concat(chunks));
    return total;
}

/** 从 Content-Type / URL 路径推断扩展名（缺省 .bin；下载命名用）。 */
export function inferExtension(contentType: string | null, url: string): string {
    if (contentType !== null) {
        const base = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
        const sub = base.split("/")[1]?.split("+")[0];
        if (base.startsWith("image/") || base.startsWith("audio/") || base.startsWith("video/")) {
            if (sub !== undefined && sub !== "") {
                return `.${sub}`;
            }
        }
    }
    try {
        const pathname = new URL(url).pathname;
        const ext = pathname.substring(pathname.lastIndexOf("."));
        if (ext.length > 1 && ext.length <= 6 && EXT_RE.test(ext)) {
            return ext.toLowerCase();
        }
    } catch {
        // URL 解析失败（理论不可达，fetch 已成功）：落 .bin
    }
    return ".bin";
}
