/**
 * Satori 发方向资源处理（从 element-convert.ts 拆分，FTA 优化）
 *
 * - resolveAsset：internal: 路径 / http(s) 下载 / 本地路径原样
 * - ensureSilk 已上移到 adapter core（core/media.ts，onebot11/satori 共用）
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { kernelError } from "@napuketto/kernel";

/** internal:{platform}/{user.id}/{path} → 本地路径（取 _tmp 之后的路径，回落 cacheDir）。 */
function resolveInternalPath(src: string): string {
    const pathPart = src.slice("internal:".length);
    const slash1 = pathPart.indexOf("/");
    const slash2 = slash1 === -1 ? -1 : pathPart.indexOf("/", slash1 + 1);
    if (slash2 === -1) {
        return pathPart;
    }
    const rest = pathPart.slice(slash2 + 1);
    // 去掉 _tmp/ 前缀段，回落到 cacheDir
    const tmpIdx = rest.indexOf("_tmp/");
    return tmpIdx === -1 ? rest : rest.slice(tmpIdx + 5);
}

/** http(s) URL 前缀。 */
const HTTP_URL_RE = /^https?:\/\//i;
/** 文件名不安全字符（URL 尾部段转文件名时替换）。 */
const UNSAFE_NAME_RE = /[^a-zA-Z0-9._-]/g;

/**
 * 解析资源 src：
 * - internal:{platform}/{user.id}/{path} → 本地路径（第一版仅支持 _tmp 保留路径）
 * - http(s):// → 下载到 cacheDir
 * - 其他 → 视为本地路径原样返回
 */
export async function resolveAsset(src: string, cacheDir: string): Promise<string> {
    if (src.startsWith("internal:")) {
        return resolveInternalPath(src);
    }
    if (HTTP_URL_RE.test(src)) {
        return downloadAsset(src, cacheDir);
    }
    return src;
}

/** 下载 URL 资源到缓存目录（返回本地路径）。 */
async function downloadAsset(url: string, cacheDir: string): Promise<string> {
    await mkdir(cacheDir, { recursive: true });
    const res = await fetch(url);
    if (!res.ok) {
        throw kernelError(`下载资源失败: ${url}`, "SEND_FAILED");
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const rawName = url.split("/").pop() ?? `asset-${Date.now()}`;
    const safeName = rawName.replace(UNSAFE_NAME_RE, "_") || `asset-${Date.now()}`;
    const filePath = join(cacheDir, safeName);
    await writeFile(filePath, buf);
    return filePath;
}
