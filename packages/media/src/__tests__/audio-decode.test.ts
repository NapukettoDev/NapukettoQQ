/**
 * audio.ts 补漏测试（silk-wasm 真实 wasm 编解码 + execa mock，不依赖真实二进制）
 *
 * 基线 audio.test.ts 已锁定 encodePcmToSilk 的主分派；本文件补：
 * - decodeSilkToPcm / decodeSilkToWav / getSilkInfo 的成功路径与非 SILK 失败路径；
 * - decodeSilkToWav 的 WAV 头字节（采样率 / 声道 / 位深 / data 长度）与 outDir；
 * - encodePcmToSilk 的立体声 / float WAV / 无采样率 raw pcm → ffmpeg 归一化分支；
 * - 归一化临时文件清理与 ffmpeg 假成功（exit 0 无输出）路径。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { encode, getDuration, isSilk } from "silk-wasm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    decodeSilkToPcm,
    decodeSilkToWav,
    encodePcmToSilk,
    getSilkInfo,
    SILK_SAMPLE_RATE,
} from "../audio.js";
import { MediaError } from "../types.js";
import { cleanupTempDir, makePcm, makeTempDir, makeWav } from "./test-support.js";

const { execaMock } = vi.hoisted(() => ({ execaMock: vi.fn() }));
vi.mock("execa", () => ({ execa: execaMock }));

/** 生成真实 SILK 夹具（silk-wasm 进程内 wasm，不经 ffmpeg）。 */
async function makeSilk(dir: string, name: string, seconds: number): Promise<string> {
    const result = await encode(makePcm(seconds, 24000), 24000);
    const path = join(dir, name);
    writeFileSync(path, Buffer.from(result.data));
    return path;
}

/** ffmpeg 归一化 mock：exit 0 并在输出路径（最后一个参数）写入 2s PCM。 */
function mockFfmpegPcmOut(): void {
    execaMock.mockImplementation(async (_cmd: string, args: string[]) => {
        const out = args.at(-1);
        if (out === undefined) {
            throw new Error("ffmpeg mock：缺输出路径参数");
        }
        writeFileSync(out, makePcm(2, SILK_SAMPLE_RATE));
        return { exitCode: 0, stdout: "" };
    });
}

/** silk 时长按 20ms 帧量化（2s 正弦 ≈ 2040ms）：断言落在 [seconds, seconds+0.2s)。 */
function expectDurationNear(actual: number, seconds: number): void {
    expect(actual).toBeGreaterThanOrEqual(seconds * 1000);
    expect(actual).toBeLessThan((seconds + 0.2) * 1000);
}

/** 读取 WAV 头关键字段（44 字节标准头）。 */
function readWavFields(buf: Buffer): {
    formatCode: number;
    channels: number;
    sampleRate: number;
    byteRate: number;
    blockAlign: number;
    bits: number;
    dataSize: number;
} {
    return {
        formatCode: buf.readUInt16LE(20),
        channels: buf.readUInt16LE(22),
        sampleRate: buf.readUInt32LE(24),
        byteRate: buf.readUInt32LE(28),
        blockAlign: buf.readUInt16LE(32),
        bits: buf.readUInt16LE(34),
        dataSize: buf.readUInt32LE(40),
    };
}

describe("decodeSilkToPcm", () => {
    let dir: string;
    beforeEach(() => {
        dir = makeTempDir("nk-media-dec-");
        execaMock.mockReset();
    });
    afterEach(() => {
        cleanupTempDir(dir);
    });

    it("SILK → pcm_s16le 文件（路径替换扩展名），时长正确", async () => {
        const silk = await makeSilk(dir, "voice.silk", 2);

        const result = await decodeSilkToPcm(silk);

        expect(normalize(result.pcmPath)).toBe(normalize(join(dir, "voice.pcm")));
        expectDurationNear(result.durationMs, 2);
        expect(existsSync(result.pcmPath)).toBe(true);
        expect(execaMock).not.toHaveBeenCalled();
    });

    it("显式采样率（16000）→ 解码成功", async () => {
        const silk = await makeSilk(dir, "voice.silk", 1);

        const result = await decodeSilkToPcm(silk, 16000);

        expectDurationNear(result.durationMs, 1);
    });

    it("非 SILK 文件 → MediaError", async () => {
        const fake = join(dir, "fake.silk");
        writeFileSync(fake, Buffer.alloc(64, 0x5a));

        await expect(decodeSilkToPcm(fake)).rejects.toThrow(MediaError);
        await expect(decodeSilkToPcm(fake)).rejects.toThrow(/不是有效的 SILK 文件/);
    });
});

describe("decodeSilkToWav", () => {
    let dir: string;
    beforeEach(() => {
        dir = makeTempDir("nk-media-wav-");
        execaMock.mockReset();
    });
    afterEach(() => {
        cleanupTempDir(dir);
    });

    it("SILK → 可播放 WAV：头字段为 24000Hz 单声道 16-bit PCM", async () => {
        const silk = await makeSilk(dir, "voice.silk", 2);

        const result = await decodeSilkToWav(silk);

        expect(normalize(result.wavPath)).toBe(normalize(join(dir, "voice.wav")));
        expectDurationNear(result.durationMs, 2);
        const buf = readFileSync(result.wavPath);
        expect(buf.subarray(0, 4).toString("ascii")).toBe("RIFF");
        expect(buf.subarray(8, 12).toString("ascii")).toBe("WAVE");
        expect(readWavFields(buf)).toEqual({
            formatCode: 1,
            channels: 1,
            sampleRate: 24000,
            byteRate: 48000,
            blockAlign: 2,
            bits: 16,
            dataSize: buf.length - 44,
        });
    });

    it("自定义采样率 → WAV 头采样率与字节率随之变化", async () => {
        const silk = await makeSilk(dir, "voice.silk", 1);

        const result = await decodeSilkToWav(silk, { sampleRate: 16000 });

        const buf = readFileSync(result.wavPath);
        const fields = readWavFields(buf);
        expect(fields.sampleRate).toBe(16000);
        expect(fields.byteRate).toBe(32000);
    });

    it("outDir 嵌套目录不存在 → 自动创建并输出到 outDir（保持文件名）", async () => {
        const silk = await makeSilk(dir, "voice.silk", 1);
        const outDir = join(dir, "nested", "out");

        const result = await decodeSilkToWav(silk, { outDir });

        expect(normalize(result.wavPath)).toBe(normalize(join(outDir, "voice.wav")));
        expect(existsSync(result.wavPath)).toBe(true);
    });

    it("非 SILK 文件 → MediaError", async () => {
        const fake = join(dir, "fake.silk");
        writeFileSync(fake, "not silk at all");

        await expect(decodeSilkToWav(fake)).rejects.toThrow(MediaError);
    });
});

describe("getSilkInfo", () => {
    let dir: string;
    beforeEach(() => {
        dir = makeTempDir("nk-media-info-");
    });
    afterEach(() => {
        cleanupTempDir(dir);
    });

    it("SILK → 时长 + 缺省采样率 24000", async () => {
        const silk = await makeSilk(dir, "voice.silk", 2);

        const info = await getSilkInfo(silk);
        expectDurationNear(info.durationMs, 2);
        expect(info.sampleRate).toBe(24000);
    });

    it("自定义采样率参数透出（silk-wasm 不暴露内部采样率）", async () => {
        const silk = await makeSilk(dir, "voice.silk", 1);

        const info = await getSilkInfo(silk, 48000);
        expectDurationNear(info.durationMs, 1);
        expect(info.sampleRate).toBe(48000);
    });

    it("非 SILK 文件 → MediaError", async () => {
        const fake = join(dir, "fake.silk");
        writeFileSync(fake, Buffer.alloc(32, 1));

        await expect(getSilkInfo(fake)).rejects.toThrow(/不是有效的 SILK 文件/);
    });
});

describe("encodePcmToSilk 归一化分支", () => {
    let dir: string;
    beforeEach(() => {
        dir = makeTempDir("nk-media-enc-");
        execaMock.mockReset();
    });
    afterEach(() => {
        cleanupTempDir(dir);
    });

    it("立体声 16-bit WAV → 经 ffmpeg 归一化后编码为合法 silk", async () => {
        mockFfmpegPcmOut();
        const wav = join(dir, "stereo.wav");
        writeFileSync(wav, makeWav({ rate: 44100, channels: 2 }, makePcm(2, 44100)));

        const silk = await encodePcmToSilk(wav);
        const buf = readFileSync(silk);

        expect(isSilk(buf)).toBe(true);
        expectDurationNear(getDuration(buf), 2);
        expect(execaMock).toHaveBeenCalledOnce();
    });

    it("IEEE float WAV（formatCode 3）→ 归一化分支", async () => {
        mockFfmpegPcmOut();
        const wav = join(dir, "float.wav");
        writeFileSync(
            wav,
            makeWav({ rate: 44100, channels: 1, bits: 32, formatCode: 3 }, makePcm(1, 44100)),
        );

        const silk = await encodePcmToSilk(wav);

        expect(isSilk(readFileSync(silk))).toBe(true);
        expect(execaMock).toHaveBeenCalledOnce();
    });

    it("raw pcm 未指定采样率 → 归一化分支（无法当 PCM 直喂）", async () => {
        mockFfmpegPcmOut();
        const pcm = join(dir, "raw.pcm");
        writeFileSync(pcm, makePcm(2, 24000));

        const silk = await encodePcmToSilk(pcm);

        expect(normalize(silk)).toBe(normalize(join(dir, "raw.silk")));
        expect(isSilk(readFileSync(silk))).toBe(true);
    });

    it("无扩展名输入 + 显式采样率 → 直接编码，输出 stem + .silk", async () => {
        const input = join(dir, "audiofile");
        writeFileSync(input, makePcm(1, 24000));

        const silk = await encodePcmToSilk(input, 24000);

        expect(normalize(silk)).toBe(normalize(join(dir, "audiofile.silk")));
        expect(execaMock).not.toHaveBeenCalled();
    });

    it("归一化成功后临时 PCM 文件被清理（.napuketto-* 不残留）", async () => {
        mockFfmpegPcmOut();
        const wav = join(dir, "stereo.wav");
        writeFileSync(wav, makeWav({ rate: 44100, channels: 2 }, makePcm(1, 44100)));

        await encodePcmToSilk(wav);

        const leftovers = readdirSync(dir).filter((name) => name.includes(".napuketto-"));
        expect(leftovers).toEqual([]);
    });

    it("ffmpeg 假成功（exit 0 但未产出）→ 抛错（读临时 PCM ENOENT）", async () => {
        execaMock.mockResolvedValue({ exitCode: 0, stdout: "" });
        const wav = join(dir, "stereo.wav");
        writeFileSync(wav, makeWav({ rate: 44100, channels: 2 }, makePcm(1, 44100)));

        await expect(encodePcmToSilk(wav)).rejects.toThrow();
    });
});
