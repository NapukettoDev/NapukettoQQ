/**
 * Satori 发方向资源处理（从 element-convert.ts 拆分，FTA 优化）
 *
 * - resolveAsset：internal: 路径 / http(s) 下载 / 本地路径原样
 * - HTTP(S) 下载遵循当前协议配置的媒体出站策略。
 */
import { inferExtension, type MediaOutboundPolicy } from "@napuketto/media";
import { cacheMediaFile, protectMediaPath } from "../../../internal/infra/media-cache.js";
import { downloadProtocolMedia } from "../../../internal/qq/media.js";

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
const UNSAFE_NAME_RE = /[^a-zA-Z0-9._-]/g;

/** Logical file title stays independent of the opaque, collision-free cache path. */
export function assetFileName(src: string): string | undefined {
    if (!HTTP_URL_RE.test(src)) return undefined;
    const name = (src.split("/").pop() ?? "").replace(UNSAFE_NAME_RE, "_");
    return name === "" || name === "." || name === ".." ? undefined : name;
}
/**
 * 解析资源 src：
 * - internal:{platform}/{user.id}/{path} → 本地路径（第一版仅支持 _tmp 保留路径）
 * - http(s):// → 下载到 cacheDir
 * - 其他 → 视为本地路径原样返回
 */
export async function resolveAsset(
    src: string,
    cacheDir: string,
    outboundPolicy?: MediaOutboundPolicy,
): Promise<string> {
    if (src.startsWith("internal:")) {
        return await protectMediaPath(resolveInternalPath(src));
    }
    if (HTTP_URL_RE.test(src)) {
        return await cacheMediaFile(cacheDir, inferExtension(null, src), async (path) => {
            await downloadProtocolMedia(src, path, { outboundPolicy, errorLabel: "下载资源失败" });
        });
    }
    return await protectMediaPath(src);
}
