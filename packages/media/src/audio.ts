import { randomBytes } from "node:crypto";
import { rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import {
    checkMediaSignal,
    FFMPEG_WORK_OPTIONS,
    LOCAL_MEDIA_INPUT_OPTIONS,
    localMediaPath,
    mediaOutputLimit,
    openMediaInput,
    publishMediaFile,
    readBoundedMediaFile,
    readMediaPrefix,
    writeFfmpegOutput,
} from "./process.js";
import type {
    AudioInfo,
    DecodedAudio,
    MediaOperationOptions,
    MediaOutputOptions,
} from "./types.js";
import { MediaError, MediaSizeLimitError, replaceExt } from "./types.js";

/** SILK 默认采样率（Hz）。 */
export const SILK_SAMPLE_RATE = 24_000;
export const MAX_AUDIO_SECONDS = 600;
export const MAX_AUDIO_INPUT_BYTES: number = 32 * 1024 * 1024;

const MAX_NORMALIZED_PCM_BYTES = MAX_AUDIO_SECONDS * SILK_SAMPLE_RATE * 2;
const MAX_SILK_WORK_MS = 30_000;
const SILK_FRAME_MS = 20;
const SILK_HEADER = Buffer.from("#!SILK_V3");
const ENCODE_SAMPLE_RATES = new Set([8000, 12000, 16000, 24000, 32000, 44100, 48000]);
const DECODE_SAMPLE_RATES = new Set([8000, 12000, 16000, 24000, 48000]);

function assertSampleRate(rate: number, allowed: ReadonlySet<number>): void {
    if (!allowed.has(rate)) throw new MediaError(`不支持的音频采样率: ${rate}`);
}

function assertAudioDuration(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > MAX_AUDIO_SECONDS * 1000) {
        throw new MediaError(`音频时长必须大于 0 且不超过 ${MAX_AUDIO_SECONDS}s`);
    }
}

function silkHeaderLength(bytes: Buffer): number {
    const prefix = bytes[0] === 2 ? 1 : 0;
    return bytes.subarray(prefix, prefix + SILK_HEADER.length).equals(SILK_HEADER)
        ? prefix + SILK_HEADER.length
        : 0;
}

/** SILK 包按长度跳过，不为元数据读取累计输入，也不接受截断的包。 */
async function silkDuration(
    chunks: AsyncIterable<Buffer> | Iterable<Buffer>,
    headerLength: number,
    signal?: AbortSignal,
): Promise<number> {
    const scan: SilkScan = {
        remaining: headerLength,
        duration: 0,
        ended: false,
        lengthLow: undefined,
    };
    let bytes = 0;
    for await (const chunk of chunks) {
        checkMediaSignal(signal);
        bytes += chunk.length;
        if (bytes > MAX_AUDIO_INPUT_BYTES) throw new MediaError("SILK 文件超出大小限制");
        consumeSilkChunk(scan, chunk);
    }
    if (scan.remaining !== 0 || scan.lengthLow !== undefined) throw new MediaError("SILK 帧不完整");
    assertAudioDuration(scan.duration);
    return scan.duration;
}

interface SilkScan {
    remaining: number;
    duration: number;
    ended: boolean;
    lengthLow: number | undefined;
}

function consumeSilkChunk(scan: SilkScan, chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
        if (scan.ended) throw new MediaError("SILK 结束标记后仍有数据");
        const skipped = Math.min(scan.remaining, chunk.length - offset);
        scan.remaining -= skipped;
        offset += skipped;
        if (offset === chunk.length) break;
        const value = chunk.readUInt8(offset++);
        if (scan.lengthLow === undefined) {
            scan.lengthLow = value;
            continue;
        }
        scan.remaining = scan.lengthLow + value * 256;
        scan.lengthLow = undefined;
        if (scan.remaining === 0xffff) {
            scan.remaining = 0;
            scan.ended = true;
            continue;
        }
        if (scan.remaining > 0x7fff) throw new MediaError("SILK 帧长度无效");
        scan.duration += SILK_FRAME_MS;
        assertAudioDuration(scan.duration);
    }
}

interface SilkResult {
    data: Uint8Array;
    duration: number;
}

/** silk-wasm 的 Promise 内部运行同步 WASM；取消时等待执行它的 Worker 退出。 */
async function runSilk(
    mode: "encode" | "decode",
    data: Buffer,
    sampleRate: number,
    signal?: AbortSignal,
): Promise<SilkResult> {
    checkMediaSignal(signal);
    const source = import.meta.url.endsWith(".ts");
    try {
        const worker = new Worker(
            new URL(source ? "./silk-worker.mts" : "./silk-worker.mjs", import.meta.url),
            {
                execArgv: source ? ["--experimental-strip-types"] : [],
                workerData: { mode, data, sampleRate },
                transferList: data.buffer instanceof ArrayBuffer ? [data.buffer] : [],
            },
        );
        return await new Promise<SilkResult>((done, reject) => {
            let result: SilkResult | undefined;
            let failure: unknown;
            const stop = (error: MediaError): void => {
                failure = error;
                worker.terminate().catch(reject);
            };
            const abort = (): void =>
                stop(new MediaError("媒体操作已取消", { cause: signal?.reason }));
            const timer = setTimeout(
                () => stop(new MediaError("SILK 编解码超时")),
                MAX_SILK_WORK_MS,
            );
            signal?.addEventListener("abort", abort, { once: true });
            worker.once("message", (message: SilkResult) => {
                result = message;
            });
            worker.once("error", (error) => {
                failure ??= error;
            });
            worker.once("exit", (code) => {
                clearTimeout(timer);
                signal?.removeEventListener("abort", abort);
                if (failure !== undefined) reject(failure);
                else if (code !== 0 || result === undefined)
                    reject(new MediaError(`SILK Worker 退出: ${code}`));
                else done(result);
            });
            if (signal?.aborted) abort();
        });
    } catch (error) {
        if (error instanceof MediaError) throw error;
        throw new MediaError("SILK 编解码失败", { cause: error });
    }
}

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

function wavHeader(bytes: number, sampleRate: number): Buffer {
    const header = Buffer.alloc(44);
    header.write("RIFF", 0, "ascii");
    header.writeUInt32LE(36 + bytes, 4);
    header.write("WAVEfmt ", 8, "ascii");
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36, "ascii");
    header.writeUInt32LE(bytes, 40);
    return header;
}

async function publishAudio(
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

interface WavPcm {
    offset: number;
    bytes: number;
    sampleRate: number;
}

function isRiffWave(header: Buffer): boolean {
    return (
        header.toString("latin1", 0, 4) === "RIFF" && header.toString("latin1", 8, 12) === "WAVE"
    );
}

function readMonoWavRate(header: Buffer, offset: number, bytes: number): number | undefined {
    if (
        bytes < 16 ||
        offset + 16 > header.length ||
        header.readUInt16LE(offset) !== 1 ||
        header.readUInt16LE(offset + 2) !== 1 ||
        header.readUInt16LE(offset + 12) !== 2 ||
        header.readUInt16LE(offset + 14) !== 16
    ) {
        return undefined;
    }
    return header.readUInt32LE(offset + 4);
}

/** Locate common PCM WAV chunks without walking the audio payload. Other WAVs use ffmpeg. */
function monoWavPcm(header: Buffer, fileSize: number): WavPcm | undefined {
    if (!isRiffWave(header) || header.readUInt32LE(4) + 8 !== fileSize) return undefined;
    let sampleRate: number | undefined;
    for (let offset = 12; offset + 8 <= header.length; ) {
        const name = header.toString("latin1", offset, offset + 4);
        const bytes = header.readUInt32LE(offset + 4);
        const data = offset + 8;
        if (data + bytes > fileSize) return undefined;
        if (name === "fmt ") {
            sampleRate = readMonoWavRate(header, data, bytes);
            if (sampleRate === undefined) return undefined;
        }
        if (name === "data" && sampleRate !== undefined && bytes % 2 === 0) {
            return { offset: data, bytes, sampleRate };
        }
        offset = data + bytes + (bytes % 2);
    }
    return undefined;
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

async function readPcm(
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

async function normalizeToPcm(
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
