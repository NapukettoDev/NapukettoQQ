import { stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
    MAX_NORMALIZED_PCM_BYTES,
    normalizeToPcm,
    publishAudio,
    readPcm,
} from "./audio/pcm-normalizer.js";
import {
    assertAudioDuration,
    assertSampleRate,
    DECODE_SAMPLE_RATES,
    MAX_AUDIO_INPUT_BYTES,
    MAX_AUDIO_SECONDS,
    SILK_SAMPLE_RATE,
    silkDuration,
    silkHeaderLength,
} from "./audio/silk-format.js";
import { runSilk, type SilkResult } from "./audio/silk-worker-client.js";
import { isRiffWave, monoWavPcm, wavHeader } from "./audio/wav-codec.js";
import {
    checkMediaSignal,
    localMediaPath,
    mediaOutputLimit,
    openMediaInput,
    readBoundedMediaFile,
    readMediaPrefix,
} from "./process.js";
import type {
    AudioInfo,
    DecodedAudio,
    MediaOperationOptions,
    MediaOutputOptions,
} from "./types.js";
import { MediaError, MediaSizeLimitError, replaceExt } from "./types.js";

export { MAX_AUDIO_INPUT_BYTES, MAX_AUDIO_SECONDS, SILK_SAMPLE_RATE } from "./audio/silk-format.js";

async function decodeAudio(
    input: string,
    sampleRate: number,
    signal?: AbortSignal,
): Promise<SilkResult> {
    assertSampleRate(sampleRate, DECODE_SAMPLE_RATES);
    checkMediaSignal(signal);
    const source = await localMediaPath(input, MAX_AUDIO_INPUT_BYTES);
    const buffer = await readBoundedMediaFile(source, MAX_AUDIO_INPUT_BYTES, signal);
    const header = silkHeaderLength(buffer);
    if (header === 0) throw new MediaError(`不是有效的 SILK 文件: ${input}`);
    await silkDuration([buffer], header, signal);
    const result = await runSilk("decode", buffer, sampleRate, signal);
    assertAudioDuration(result.duration);
    if (
        result.data.byteLength === 0 ||
        result.data.byteLength > MAX_AUDIO_SECONDS * sampleRate * 2
    ) {
        throw new MediaError("解码 PCM 超出大小限制或为空");
    }
    return result;
}

/** 解码 SILK 音频为 PCM（pcm_s16le）。 */
export async function decodeSilkToPcm(
    input: string,
    sampleRate: number = SILK_SAMPLE_RATE,
    { signal }: MediaOperationOptions = {},
): Promise<DecodedAudio> {
    const result = await decodeAudio(input, sampleRate, signal);
    const pcmPath = replaceExt(input, ".pcm");
    await publishAudio(input, pcmPath, [result.data], signal);
    return { pcmPath, durationMs: result.duration };
}

export interface DecodeSilkToWavOptions extends MediaOperationOptions {
    /** 缺省 24 kHz。 */
    sampleRate?: number | undefined;
    /** 缺省输入同目录。 */
    outDir?: string | undefined;
}

export interface DecodedWav {
    wavPath: string;
    durationMs: number;
}

/** 解码 SILK 为可播放 WAV，返回的文件由调用方管理。 */
export async function decodeSilkToWav(
    input: string,
    { sampleRate = SILK_SAMPLE_RATE, outDir, signal }: DecodeSilkToWavOptions = {},
): Promise<DecodedWav> {
    const result = await decodeAudio(input, sampleRate, signal);
    const wavPath = join(outDir ?? dirname(input), replaceExt(basename(input), ".wav"));
    await publishAudio(
        input,
        wavPath,
        [wavHeader(result.data.byteLength, sampleRate), result.data],
        signal,
    );
    return { wavPath, durationMs: result.duration };
}

export interface SilkEncodeOptions extends MediaOutputOptions {
    /** 转码目标。指定时父目录须已存在，且由调用方控制。 */
    outputPath?: string | undefined;
    /** 归一化 PCM 清理后报告其实际写入量。 */
    onPcmWritten?: ((bytes: number) => void) | undefined;
}

/** 编码音频为 SILK；已通过边界检查的 SILK 原样返回。 */
export async function encodePcmToSilk(
    input: string,
    sampleRate = 0,
    options: SilkEncodeOptions = {},
): Promise<string> {
    const { signal, maxOutputBytes, onPcmWritten } = options;
    const limit = mediaOutputLimit(
        MAX_NORMALIZED_PCM_BYTES + MAX_AUDIO_INPUT_BYTES,
        maxOutputBytes,
    );
    checkMediaSignal(signal);
    const source = await localMediaPath(input, MAX_AUDIO_INPUT_BYTES);
    const prefix = await readMediaPrefix(source, 12, signal);
    if (silkHeaderLength(prefix) !== 0) {
        await getSilkInfo(source, SILK_SAMPLE_RATE, { signal });
        return input;
    }
    const wav = isRiffWave(prefix);
    const pcm = wav
        ? monoWavPcm(await readMediaPrefix(source, 512 * 1024, signal), (await stat(source)).size)
        : undefined;
    const directRate = pcm?.sampleRate ?? (wav ? 0 : sampleRate);
    const silkPath = options.outputPath ?? replaceExt(input, ".silk");
    const data =
        pcm !== undefined || directRate !== 0
            ? await readPcm(source, directRate, pcm, signal)
            : await normalizeToPcm(source, dirname(silkPath), limit, signal);
    const pcmBytes = directRate === 0 ? data.byteLength : 0;
    if (pcmBytes > 0) onPcmWritten?.(pcmBytes);
    const result = await runSilk("encode", data, directRate || SILK_SAMPLE_RATE, signal);
    assertAudioDuration(result.duration);
    if (result.data.byteLength > Math.min(MAX_AUDIO_INPUT_BYTES, limit - pcmBytes)) {
        throw new MediaSizeLimitError("SILK 输出超出大小限制");
    }
    if (result.data.byteLength === 0) throw new MediaError("SILK 输出为空");
    await publishAudio(input, silkPath, [result.data], signal);
    return silkPath;
}

/** 获取 SILK 音频时长。SILK 容器不携带采样率，返回调用方指定值。 */
export async function getSilkInfo(
    input: string,
    sampleRate: number = SILK_SAMPLE_RATE,
    { signal }: MediaOperationOptions = {},
): Promise<AudioInfo> {
    assertSampleRate(sampleRate, DECODE_SAMPLE_RATES);
    checkMediaSignal(signal);
    const source = await localMediaPath(input, MAX_AUDIO_INPUT_BYTES);
    const handle = await openMediaInput(source);
    try {
        const info = await handle.stat();
        if (!info.isFile() || info.size === 0 || info.size > MAX_AUDIO_INPUT_BYTES) {
            throw new MediaError("无效的 SILK 文件或输入超出大小限制");
        }
        const prefix = Buffer.alloc(10);
        const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
        const header = silkHeaderLength(prefix.subarray(0, bytesRead));
        if (header === 0) throw new MediaError(`不是有效的 SILK 文件: ${input}`);
        const stream = handle.createReadStream({ start: 0, autoClose: false, signal });
        return { durationMs: await silkDuration(stream, header, signal), sampleRate };
    } catch (error) {
        checkMediaSignal(signal);
        if (error instanceof MediaError) throw error;
        throw new MediaError("无法读取 SILK 信息", { cause: error });
    } finally {
        await handle.close();
    }
}
