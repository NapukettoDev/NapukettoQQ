import { kernelError } from "@napuketto/kernel";
import { inferExtension, type MediaOutboundPolicy } from "@napuketto/media";
import { resolveLocalMedia } from "../../../internal/infra/local-media.js";
import { cacheMediaFile, leaseInternalMedia } from "../../../internal/infra/media-cache.js";
import { downloadProtocolMedia } from "../../../internal/qq/media.js";

/** http(s) URL 前缀。 */
const HTTP_URL_RE = /^https?:\/\//i;
const UNSAFE_NAME_RE = /[^a-zA-Z0-9._-]/g;

/** Logical file title stays independent of the opaque, collision-free cache path. */
export function assetFileName(src: string): string | undefined {
    if (!HTTP_URL_RE.test(src)) return undefined;
    const name = (src.split("/").pop() ?? "").replace(UNSAFE_NAME_RE, "_");
    return name === "" || name === "." || name === ".." ? undefined : name;
}
interface AssetOptions {
    outboundPolicy?: MediaOutboundPolicy | undefined;
    localMediaRoots?: readonly string[] | undefined;
    account?: string;
}

export async function resolveAsset(
    src: string,
    cacheDir: string,
    opts: AssetOptions = {},
): Promise<string> {
    if (src.startsWith("internal:")) {
        const [platform, account, namespace, entry, file, extra] = src
            .slice("internal:".length)
            .split("/");
        if (
            platform !== "qq" ||
            account === undefined ||
            account !== opts.account ||
            namespace !== "_tmp" ||
            entry === undefined ||
            file === undefined ||
            extra !== undefined
        ) {
            throw kernelError("内部媒体引用不属于当前平台及账号", "INVALID_PARAM");
        }
        return await leaseInternalMedia(cacheDir, account, entry, file);
    }
    if (HTTP_URL_RE.test(src)) {
        return await cacheMediaFile(cacheDir, inferExtension(null, src), async (path) => {
            await downloadProtocolMedia(src, path, {
                outboundPolicy: opts.outboundPolicy,
                errorLabel: "下载资源失败",
            });
        });
    }
    return await resolveLocalMedia(src, opts.localMediaRoots);
}
