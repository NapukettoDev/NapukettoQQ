import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
    checkMediaSignal,
    FFMPEG_WORK_OPTIONS,
    LOCAL_MEDIA_INPUT_OPTIONS,
    publishMediaFile,
    readBoundedMediaFile,
    writeFfmpegOutput,
} from "../process.js";
import { MediaError, MediaSizeLimitError } from "../types.js";
import {
    assertAudioDuration,
    assertSampleRate,
    ENCODE_SAMPLE_RATES,
    MAX_AUDIO_INPUT_BYTES,
    MAX_AUDIO_SECONDS,
    SILK_SAMPLE_RATE,
} from "./silk-format.js";
import type { WavPcm } from "./wav-codec.js";

export const MAX_NORMALIZED_PCM_BYTES: number = MAX_AUDIO_SECONDS * SILK_SAMPLE_RATE * 2;

export async function readPcm(
    source: string,
    sampleRate: number,
    wav: WavPcm | undefined,
    signal?: AbortSignal,
): Promise<Buffer> {
    assertSampleRate(sampleRate, ENCODE_SAMPLE_RATES);
    const file = await readBoundedMediaFile(source, MAX_AUDIO_INPUT_BYTES, signal);
    const data = wav === undefined ? file : file.subarray(wav.offset, wav.offset + wav.bytes);
    if (data.byteLength % 2 !== 0 || (wav !== undefined && wav.bytes !== data.byteLength)) {
        throw new MediaError("PCM 输入帧不完整");
    }
    assertAudioDuration((data.byteLength * 500) / sampleRate);
    return data;
}

export async function normalizeToPcm(
    source: string,
    directory: string,
    limit: number,
    signal?: AbortSignal,
): Promise<Buffer> {
    const partial = join(directory, `.napuketto-${randomBytes(8).toString("hex")}.pcm`);
    const maxBytes = Math.min(MAX_NORMALIZED_PCM_BYTES, limit);
    try {
        await writeFfmpegOutput(
            [
                "-nostdin",
                "-v",
                "error",
                ...FFMPEG_WORK_OPTIONS,
                ...LOCAL_MEDIA_INPUT_OPTIONS,
                "-i",
                source,
                "-map",
                "0:a:0",
                "-ac",
                "1",
                "-ar",
                String(SILK_SAMPLE_RATE),
                "-t",
                String(MAX_AUDIO_SECONDS + 0.02),
                "-f",
                "s16le",
            ],
            partial,
            maxBytes,
            120_000,
            signal,
        );
        return await readBoundedMediaFile(partial, maxBytes, signal);
    } catch (error) {
        checkMediaSignal(signal);
        if (error instanceof MediaSizeLimitError) throw error;
        throw new MediaError(`ffmpeg 音频归一化失败: ${source}`, { cause: error });
    } finally {
        await rm(partial, { force: true });
    }
}

export async function publishAudio(
    input: string,
    output: string,
    chunks: readonly Uint8Array[],
    signal?: AbortSignal,
): Promise<void> {
    const source = resolve(input);
    const target = resolve(output);
    if (
        source === target ||
        (process.platform === "win32" && source.toLowerCase() === target.toLowerCase())
    ) {
        throw new MediaError("音频输出不能覆盖输入文件");
    }
    try {
        await publishMediaFile(output, chunks, signal);
    } catch (error) {
        checkMediaSignal(signal);
        throw new MediaError("无法写出音频产物", { cause: error });
    }
}
