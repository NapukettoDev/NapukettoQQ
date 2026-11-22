/**
 * Satori 媒体元素 → canonical 转换器
 *
 * img / audio / video / file 四个媒体类型：src → 本地路径（internal: 路径 /
 * http 下载 / 本地原样），audio 额外 silk 转码（非 silk 失败原样返回），
 * video 非 mp4 输入经 ffmpeg 归一化（ffmpeg 缺失/失败原样）。
 *
 * 发方向依赖契约（SatoriToCanonicalDeps）也收在本文件：element-convert 与
 * 本文件都消费它，放这里可避免 element-convert ↔ media-convert 循环引用。
 */
import type { CanonicalElement } from "@napuketto/kernel";
import { type MediaOutboundPolicy, transcodeVideo } from "@napuketto/media";
import { ensureSilk } from "../../../internal/qq/media.js";
import { assetFileName, resolveAsset } from "./asset.js";
import type { SatoriElement } from "./element.js";

/** 发方向依赖（at uin 转换 + 资源下载目录）。 */
export interface SatoriToCanonicalDeps {
    /** uin → uid（at 目标转换）。 */
    uinToUid: (uins: string[]) => Promise<Map<string, string>>;
    /** 资源（img/audio/video/file）下载缓存目录。 */
    cacheDir: string;
    outboundPolicy?: MediaOutboundPolicy | undefined;
    /** 转码成功即转移输出文件及其父临时目录的所有权；发送消费结束后清理。 */
    onVideoTranscoded?: (path: string) => void;
}

/** 解析元素媒体 src（空 → null 忽略），返回本地路径。 */
async function resolveMediaSrc(
    el: SatoriElement,
    deps: SatoriToCanonicalDeps,
): Promise<string | null> {
    const src = el.attrs?.["src"] ?? "";
    if (src === "") {
        return null;
    }
    return resolveAsset(src, deps.cacheDir, deps.outboundPolicy);
}

/** Satori img → canonical image。 */
async function imgToCanonical(
    el: SatoriElement,
    deps: SatoriToCanonicalDeps,
): Promise<CanonicalElement[]> {
    const path = await resolveMediaSrc(el, deps);
    return path === null ? [] : [{ type: "image", path }];
}

/** Satori audio → canonical voice（非 silk 转码）。 */
async function audioToCanonical(
    el: SatoriElement,
    deps: SatoriToCanonicalDeps,
): Promise<CanonicalElement[]> {
    const path = await resolveMediaSrc(el, deps);
    return path === null ? [] : [{ type: "voice", path: await ensureSilk(path) }];
}

/**
 * Satori video → canonical video（非 mp4 输入 ffmpeg 归一化，fail-soft）。
 *
 * QQ 视频协议固定 mp4/H.264；非 mp4（webm/mov 等）先转码，ffmpeg 缺失或
 * 转码失败原样透传（kernel 发送侧兜底，可能发送失败但不阻断装配）。
 */
async function videoToCanonical(
    el: SatoriElement,
    deps: SatoriToCanonicalDeps,
): Promise<CanonicalElement[]> {
    const path = await resolveMediaSrc(el, deps);
    if (path === null) {
        return [];
    }
    if (path.toLowerCase().endsWith(".mp4")) {
        return [{ type: "video", path }];
    }
    let output: string;
    try {
        output = await transcodeVideo(path);
    } catch {
        // fail-soft：ffmpeg 缺失/转码失败原样透传
        return [{ type: "video", path }];
    }
    deps.onVideoTranscoded?.(output);
    return [{ type: "video", path: output }];
}

/** Satori file → canonical file（title → name）。 */
async function fileToCanonical(
    el: SatoriElement,
    deps: SatoriToCanonicalDeps,
): Promise<CanonicalElement[]> {
    const path = await resolveMediaSrc(el, deps);
    if (path === null) {
        return [];
    }
    const title = el.attrs?.["title"] || assetFileName(el.attrs?.["src"] ?? "");
    const base: CanonicalElement = { type: "file", path };
    if (title !== undefined && title !== "") {
        return [{ ...base, name: title }];
    }
    return [base];
}

/** 媒体元素转换器子表（并入 element-convert 主表）。 */
export const MEDIA_CONVERTERS = {
    img: imgToCanonical,
    audio: audioToCanonical,
    video: videoToCanonical,
    file: fileToCanonical,
};
