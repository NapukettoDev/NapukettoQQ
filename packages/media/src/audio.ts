/**
 * 音频（silk-wasm + ffmpeg）
 *
 * - `decodeSilkToPcm`：SILK → pcm_s16le 文件 + 时长
 * - `encodePcmToSilk`：任意音频（wav/pcm/mp3/ogg/amr/flac…）→ SILK 文件
 * - `getSilkInfo`：SILK 音频信息（时长 / 采样率）
 *
 * silk-wasm 的 `encode` 只接受「单声道 16-bit PCM WAV / 单声道 pcm_s16le」；立体声、非 16-bit、
 * 或压缩编码（mp3/ogg/amr/flac 等）一律先经 ffmpeg 归一化为 24000Hz 单声道 pcm_s16le 再编码
 * （QQ 语音协议 silk v3 固定 24000Hz，ffmpeg 用法同 video.ts，依赖系统 PATH 中的 ffmpeg）。
 */
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execa } from "execa";
import { decode, encode, getDuration, getWavFileInfo, isSilk, isWav } from "silk-wasm";
import {
    assertMediaOutput,
    LOCAL_MEDIA_INPUT_OPTIONS,
    localMediaPath,
    mediaProcessOptions,
    readBoundedMediaFile,
} from "./process.js";
import type { AudioInfo, DecodedAudio } from "./types.js";
import { MediaError, replaceExt } from "./types.js";

/** SILK 默认采样率（Hz）。 */
export const SILK_SAMPLE_RATE = 24_000;

const MAX_AUDIO_SECONDS = 600;
const MAX_AUDIO_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_NORMALIZED_PCM_BYTES = MAX_AUDIO_SECONDS * SILK_SAMPLE_RATE * 2;
const ENCODE_SAMPLE_RATES = new Set([8000, 12000, 16000, 24000, 32000, 44100, 48000]);
const DECODE_SAMPLE_RATES = new Set([8000, 12000, 16000, 24000, 48000]);

function assertSampleRate(rate: number, decoding = false): void {
    if (!(decoding ? DECODE_SAMPLE_RATES : ENCODE_SAMPLE_RATES).has(rate)) {
        throw new MediaError(`不支持的音频采样率: ${rate}`);
    }
}

function assertAudioDuration(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_AUDIO_SECONDS) {
        throw new MediaError(`音频时长必须大于 0 且不超过 ${MAX_AUDIO_SECONDS}s`);
    }
}

async function readAudioInput(input: string): Promise<Buffer> {
    const source = await localMediaPath(input);
    return readBoundedMediaFile(source, MAX_AUDIO_INPUT_BYTES);
}

function assertSilkDuration(buffer: Buffer): void {
    try {
        assertAudioDuration(getDuration(buffer) / 1000);
    } catch (error) {
        throw new MediaError("SILK 时长无效或超出限制", { cause: error });
    }
}

function assertDecodedAudio(data: Uint8Array, durationMs: number, sampleRate: number): void {
    assertAudioDuration(durationMs / 1000);
    if (data.byteLength === 0 || data.byteLength > MAX_AUDIO_SECONDS * sampleRate * 2) {
        throw new MediaError("解码 PCM 超出大小限制或为空");
    }
}

/** 解码 SILK 音频为 PCM（pcm_s16le）。 */
export async function decodeSilkToPcm(
    input: string,
    sampleRate = SILK_SAMPLE_RATE,
): Promise<DecodedAudio> {
    assertSampleRate(sampleRate, true);
    const buffer = await readAudioInput(input);
    if (!isSilk(buffer)) {
        throw new MediaError(`不是有效的 SILK 文件: ${input}`);
    }
    assertSilkDuration(buffer);
    const result = await decode(buffer, sampleRate);
    assertDecodedAudio(result.data, result.duration, sampleRate);
    const pcmPath = replaceExt(input, ".pcm");
    mkdirSync(dirname(pcmPath), { recursive: true });
    await writeFile(pcmPath, result.data);
    return { pcmPath, durationMs: result.duration };
}

/** 解码 SILK → WAV 输出选项。 */
export interface DecodeSilkToWavOptions {
    /** 采样率（缺省 24000，QQ 语音协议值）。 */
    sampleRate?: number | undefined;
    /** 输出目录（缺省输入同目录；收方向解码建议 tmpdir，避免污染 NT 数据目录）。 */
    outDir?: string | undefined;
}

/** 解码结果（WAV）。 */
export interface DecodedWav {
    wavPath: string;
    durationMs: number;
}

/**
 * 解码 SILK → WAV 文件（pcm_s16le 单声道 + 44 字节头，通用可播放格式）。
 * 收方向语音接线用（koishi h.audio / 外部客户端）：QQ 语音是 silk v3，
 * 多数播放器无法直接解码，落 WAV 后以本地路径消费。
 */
export async function decodeSilkToWav(
    input: string,
    options: DecodeSilkToWavOptions = {},
): Promise<DecodedWav> {
    const sampleRate = options.sampleRate ?? SILK_SAMPLE_RATE;
    assertSampleRate(sampleRate, true);
    const buffer = await readAudioInput(input);
    if (!isSilk(buffer)) {
        throw new MediaError(`不是有效的 SILK 文件: ${input}`);
    }
    assertSilkDuration(buffer);
    const result = await decode(buffer, sampleRate);
    assertDecodedAudio(result.data, result.duration, sampleRate);
    const { dir, name } = outputTarget(input, ".wav", options.outDir);
    const wav = wrapPcmInWav(result.data, sampleRate);
    await writeFile(join(dir, name), wav);
    return { wavPath: join(dir, name), durationMs: result.duration };
}

/** 输出目标（目录 + 文件名；outDir 优先，否则输入同目录替换扩展名）。 */
function outputTarget(input: string, ext: string, outDir?: string): { dir: string; name: string } {
    const base = input.replaceAll("\\", "/").split("/").pop() ?? "audio";
    const dot = base.lastIndexOf(".");
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const name = `${stem}${ext}`;
    const dir = outDir !== undefined ? outDir : dirname(input);
    mkdirSync(dir, { recursive: true });
    return { dir, name };
}

/** PCM（s16le 单声道）→ WAV 文件字节（44 字节头 + 数据）。 */
function wrapPcmInWav(pcm: Uint8Array, sampleRate: number): Buffer {
    const bytesPerSample = 2;
    const blockAlign = bytesPerSample; // 单声道
    const header = Buffer.alloc(44);
    header.write("RIFF", 0, "ascii");
    header.writeUInt32LE(36 + pcm.byteLength, 4);
    header.write("WAVE", 8, "ascii");
    header.write("fmt ", 12, "ascii");
    header.writeUInt32LE(16, 16); // fmt 块长度（PCM 固定 16）
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(1, 22); // 单声道
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE((sampleRate * blockAlign) | 0, 28); // 字节率
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bytesPerSample * 8, 34); // 位深
    header.write("data", 36, "ascii");
    header.writeUInt32LE(pcm.byteLength, 40);
    return Buffer.concat([header, Buffer.from(pcm)]);
}

/**
 * 编码任意音频为 SILK 文件（返回输出路径，输出紧随输入文件）。
 *
 * - 已是 SILK → 原样返回
 * - 单声道 16-bit PCM WAV / 显式采样率的原始 pcm_s16le → silk-wasm 直接编码
 * - 其余（立体声/浮点/非 16-bit WAV、mp3/ogg/amr/flac 等）→ ffmpeg 归一化为
 *   24000Hz 单声道 pcm_s16le → silk-wasm 编码
 */
export async function encodePcmToSilk(input: string, sampleRate = 0): Promise<string> {
    const buffer = await readAudioInput(input);
    if (isSilk(buffer)) {
        assertSilkDuration(buffer);
        return input;
    }

    let result: { data: Uint8Array };
    if (isWav(buffer)) {
        const info = getWavFileInfo(buffer);
        const mono16Pcm =
            info.fmt.numberOfChannels === 1 &&
            info.fmt.formatCode === 1 &&
            info.fmt.bitsPerSample === 16;
        if (mono16Pcm) {
            assertSampleRate(info.fmt.sampleRate);
            const data = info.chunkInfo.find((chunk) => chunk.chunkId === "data");
            assertAudioDuration((data?.dataLength ?? 0) / (info.fmt.sampleRate * 2));
            // 单声道 16-bit PCM WAV：silk-wasm 可直接编码（rate=0 自动读 WAV 头）
            result = await encode(buffer, 0);
        } else {
            // 立体声 / 非 16-bit（浮点、24bit）/ 压缩 WAV → ffmpeg 归一化
            result = await encode(await normalizeToPcm(input), SILK_SAMPLE_RATE);
        }
    } else if (sampleRate > 0) {
        assertSampleRate(sampleRate);
        assertAudioDuration(buffer.byteLength / (sampleRate * 2));
        // 原始 pcm_s16le（调用方显式指定采样率）
        result = await encode(buffer, sampleRate);
    } else {
        // mp3/ogg/amr/flac 等压缩编码（未指定采样率，无法当 PCM 直接喂 silk-wasm）
        result = await encode(await normalizeToPcm(input), SILK_SAMPLE_RATE);
    }

    const silkPath = replaceExt(input, ".silk");
    mkdirSync(dirname(silkPath), { recursive: true });
    await writeFile(silkPath, result.data);
    return silkPath;
}

/**
 * ffmpeg 归一化：任意音频 → 24000Hz 单声道 pcm_s16le（写临时文件，返回 PCM 数据）。
 *
 * 输入目录与 .silk 输出同目录（保证可写），临时文件编码后删除。
 */
async function normalizeToPcm(input: string): Promise<Uint8Array> {
    const source = await localMediaPath(input);
    const tmpPath = join(dirname(source), `.napuketto-${randomBytes(8).toString("hex")}.pcm`);
    try {
        const result = await execa(
            "ffmpeg",
            [
                "-nostdin",
                "-v",
                "error",
                "-y",
                ...LOCAL_MEDIA_INPUT_OPTIONS,
                "-i",
                source,
                "-vn",
                "-ac",
                "1",
                "-ar",
                String(SILK_SAMPLE_RATE),
                // Decode one extra frame as a sentinel: overlong audio fails instead of truncating.
                "-t",
                String(MAX_AUDIO_SECONDS + 0.02),
                "-fs",
                String(MAX_NORMALIZED_PCM_BYTES + 2),
                "-f",
                "s16le",
                tmpPath,
            ],
            mediaProcessOptions(120_000),
        );
        if (result.exitCode !== 0 || result.failed) {
            throw new MediaError(
                `ffmpeg 音频归一化失败: ${input}（exit ${result.exitCode ?? "spawn failed"}）`,
                { cause: result },
            );
        }
        await assertMediaOutput(tmpPath, MAX_NORMALIZED_PCM_BYTES);
        return new Uint8Array(await readBoundedMediaFile(tmpPath, MAX_NORMALIZED_PCM_BYTES));
    } catch (error) {
        if (error instanceof MediaError) {
            throw error;
        }
        throw new MediaError(`ffmpeg 音频归一化失败: ${input}`, { cause: error });
    } finally {
        await rm(tmpPath, { force: true });
    }
}

/** 获取 SILK 音频信息（时长 / 采样率）。 */
export async function getSilkInfo(
    input: string,
    sampleRate = SILK_SAMPLE_RATE,
): Promise<AudioInfo> {
    const buffer = await readFile(input);
    if (!isSilk(buffer)) {
        throw new MediaError(`不是有效的 SILK 文件: ${input}`);
    }
    // silk-wasm 不暴露 silk 内部采样率；QQ 语音 silk v3 固定 24000Hz，沿用调用方值。
    return { durationMs: getDuration(buffer), sampleRate };
}
