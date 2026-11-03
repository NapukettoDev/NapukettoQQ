/**
 * Satori 媒体元素 → canonical 转换器（从 element-convert.ts 拆分，2026-08-08）
 *
 * img / audio / video / file 四个媒体类型：src → 本地路径（internal: 路径 /
 * http 下载 / 本地原样），audio 额外 silk 转码（非 silk 失败原样返回），
 * video 非 mp4 输入经 ffmpeg 归一化（2026-09-08 T6；ffmpeg 缺失/失败原样）。
 *
 * deps 类型来自 deps.js（独立契约文件，避免与 element-convert 循环引用）。
 */
import type { CanonicalElement } from "@napuketto/kernel";
import { transcodeVideo } from "@napuketto/media";
import { ensureSilk } from "../../../core/shared/media.js";
import { resolveAsset } from "./asset.js";
import type { SatoriToCanonicalDeps } from "./deps.js";
import type { SatoriElement } from "./element.js";

/** 解析元素媒体 src（空 → null 忽略），返回本地路径。 */
async function resolveMediaSrc(
    el: SatoriElement,
    deps: SatoriToCanonicalDeps,
): Promise<string | null> {
    const src = el.attrs?.["src"] ?? "";
    if (src === "") {
        return null;
    }
    return resolveAsset(src, deps.cacheDir);
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
    try {
        return [{ type: "video", path: await transcodeVideo(path) }];
    } catch {
        // fail-soft：ffmpeg 缺失/转码失败原样透传
        return [{ type: "video", path }];
    }
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
    const title = el.attrs?.["title"];
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
