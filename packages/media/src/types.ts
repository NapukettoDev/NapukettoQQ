/**
 * @napuketto/media 统一返回结构（ADR-011）
 *
 * 媒体编解码与文件识别的公共类型：图片尺寸、文件类型、音频/视频信息。
 */

/** 图片尺寸（宽高，像素）。 */
export interface ImageSize {
    width: number;
    height: number;
}

/** 文件类型识别结果。 */
export interface FileTypeResult {
    /** 扩展名（不带点，如 "png" / "mp3"）。 */
    ext: string;
    /** MIME 类型，如 "image/png" / "audio/mpeg"。 */
    mime: string;
}

/** 音频信息。 */
export interface AudioInfo {
    /** 时长（毫秒）。 */
    durationMs: number;
    /** 采样率（Hz），如 24000。 */
    sampleRate: number;
}

/** 视频信息。 */
export interface VideoInfo {
    width: number;
    height: number;
    /** 时长（毫秒）。 */
    durationMs: number;
}

export interface MediaOperationOptions {
    signal?: AbortSignal | undefined;
}

/** 视频转码选项。 */
export interface TranscodeOptions extends MediaOperationOptions {
    /** 偶整数，2–4096。只指定一边时保持比例。 */
    width?: number | undefined;
    /** 偶整数，2–4096。 */
    height?: number | undefined;
    /** 有限数，1–60。 */
    fps?: number | undefined;
}

/** SILK 解码产物（pcm_s16le）。 */
export interface DecodedAudio {
    /** PCM 文件路径。 */
    pcmPath: string;
    /** 时长（毫秒）。 */
    durationMs: number;
}

/** 无法识别的文件类型（file-type 返回 undefined 时）。 */
export class MediaError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "MediaError";
    }
}

/**
 * 替换文件扩展名（保持目录与分隔符风格，父目录存在性由调用方保证）。
 * 统一实现供 audio / video 复用；同时兼容 POSIX `/` 与 Windows `\` 分隔符。
 */
export function replaceExt(input: string, ext: string): string {
    const slash = input.lastIndexOf("/");
    const backslash = input.lastIndexOf("\\");
    const dirEnd = Math.max(slash, backslash);
    let dir: string;
    let base: string;
    if (dirEnd >= 0) {
        dir = input.slice(0, dirEnd + 1);
        base = input.slice(dirEnd + 1);
    } else {
        dir = "";
        base = input;
    }
    const dot = base.lastIndexOf(".");
    let stem: string;
    if (dot > 0) {
        stem = base.slice(0, dot);
    } else {
        stem = base;
    }
    return `${dir}${stem}${ext}`;
}
