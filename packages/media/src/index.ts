/**
 * @napuketto/media 入口（媒体编解码与文件识别，ADR-011）
 *
 * 严格解耦：只被协议层（adapter）依赖，kernel 不背媒体依赖。
 */

export type { DecodedWav, DecodeSilkToWavOptions, SilkEncodeOptions } from "./audio.js";
export {
    decodeSilkToPcm,
    decodeSilkToWav,
    encodePcmToSilk,
    getSilkInfo,
    MAX_AUDIO_INPUT_BYTES,
    MAX_AUDIO_SECONDS,
    SILK_SAMPLE_RATE,
} from "./audio.js";
export type { DownloadUrlOptions, MediaOutboundPolicy } from "./downloader.js";
export {
    DEFAULT_DOWNLOAD_MAX_BYTES,
    downloadPublicUrl,
    downloadUrl,
    inferExtension,
} from "./downloader.js";
export { detectFileType, getImageSize } from "./image.js";
export type {
    AudioInfo,
    DecodedAudio,
    FileTypeResult,
    ImageSize,
    MediaOperationOptions,
    MediaOutputOptions,
    TranscodeOptions,
    VideoInfo,
} from "./types.js";
export { MediaError, MediaSizeLimitError } from "./types.js";
export { extractVideoFrame, getVideoInfo, transcodeVideo } from "./video.js";
