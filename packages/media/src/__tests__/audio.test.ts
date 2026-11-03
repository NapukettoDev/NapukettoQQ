/**
 * audio.ts 基线测试
 *
 * 锁定 encodePcmToSilk 的格式分派：
 * - 单声道 16-bit PCM WAV → silk-wasm 直接编码（不经 ffmpeg）
 * - 已是 silk → 原样返回
 * - 原始 pcm_s16le + 显式采样率 → silk-wasm 直接编码
 * - 压缩编码（mp3/ogg 等）→ ffmpeg 归一化后编码；ffmpeg 失败抛 MediaError
 *   （回归「divide by zero → 静默回落原文件」bug）
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDuration, isSilk } from "silk-wasm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodePcmToSilk, SILK_SAMPLE_RATE } from "../audio.js";

const { execaMock } = vi.hoisted(() => ({ execaMock: vi.fn() }));
vi.mock("execa", () => ({ execa: execaMock }));

/** 生成正弦波 pcm_s16le（避免全零被编码器特殊处理）。 */
function makePcm(seconds: number, rate: number): Buffer {
    const n = seconds * rate;
    const buf = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) {
        buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), i * 2);
    }
    return buf;
}

/** 生成单声道/立体声 16-bit PCM WAV（44 字节 RIFF 头）。 */
function makeWav(pcm: Buffer, rate: number, channels: number): Buffer {
    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(rate, 24);
    header.writeUInt32LE(rate * channels * 2, 28);
    header.writeUInt16LE(channels * 2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36);
    header.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([header, pcm]);
}

describe("encodePcmToSilk", () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "napuketto-media-"));
        execaMock.mockReset();
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it("单声道 16-bit WAV → 合法 silk，时长正确（不经 ffmpeg）", async () => {
        const wav = join(dir, "a.wav");
        writeFileSync(wav, makeWav(makePcm(2, 24_000), 24_000, 1));

        const silk = await encodePcmToSilk(wav);
        const buf = readFileSync(silk);

        expect(isSilk(buf)).toBe(true);
        expect(getDuration(buf)).toBe(2000);
        expect(execaMock).not.toHaveBeenCalled();
    });

    it("已是 silk → 原样返回（不重新编码）", async () => {
        const wav = join(dir, "a.wav");
        writeFileSync(wav, makeWav(makePcm(1, 24_000), 24_000, 1));
        const silk = await encodePcmToSilk(wav);

        await expect(encodePcmToSilk(silk)).resolves.toBe(silk);
    });

    it("原始 pcm_s16le + 显式采样率 → 合法 silk（不经 ffmpeg）", async () => {
        const pcmPath = join(dir, "raw.pcm");
        writeFileSync(pcmPath, makePcm(2, 24_000));

        const silk = await encodePcmToSilk(pcmPath, 24_000);
        const buf = readFileSync(silk);

        expect(isSilk(buf)).toBe(true);
        expect(getDuration(buf)).toBe(2000);
        expect(execaMock).not.toHaveBeenCalled();
    });

    it("压缩编码（伪 mp3）→ ffmpeg 归一化后编码为合法 silk", async () => {
        const mp3 = join(dir, "voice.mp3");
        writeFileSync(mp3, Buffer.alloc(64 * 1024, 0x5a));
        execaMock.mockImplementation(async (_cmd: string, args: string[]) => {
            const out = args.at(-1);
            if (out === undefined) {
                throw new Error("ffmpeg mock：缺输出路径参数");
            }
            writeFileSync(out, makePcm(2, SILK_SAMPLE_RATE));
            return { exitCode: 0 };
        });

        const silk = await encodePcmToSilk(mp3);
        const buf = readFileSync(silk);

        expect(isSilk(buf)).toBe(true);
        expect(getDuration(buf)).toBe(2000);
        expect(execaMock).toHaveBeenCalledOnce();
    });

    it("ffmpeg 归一化失败 → 抛 MediaError（不再 divide by zero / 静默回落）", async () => {
        const mp3 = join(dir, "voice.mp3");
        writeFileSync(mp3, Buffer.alloc(64 * 1024, 0x5a));
        execaMock.mockImplementation(async () => ({ exitCode: 1 }));

        await expect(encodePcmToSilk(mp3)).rejects.toThrow("ffmpeg 音频归一化失败");
    });
});
