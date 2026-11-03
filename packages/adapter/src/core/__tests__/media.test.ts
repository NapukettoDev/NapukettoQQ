/**
 * core/media.ts 基线测试
 *
 * 锁定 ensureSilk 的两条路径（协议层语音发送统一入口）：
 * - 已是 silk（#!SILK 头）→ 原样返回（不重新编码）
 * - 非 silk（单声道 16-bit PCM WAV）→ 转码为 silk（生成 .silk 文件）
 * - 文件不存在 → 原样返回（转码失败兜底，由 kernel 发送时再报错）
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureSilk } from "../shared/media.js";

/** 生成正弦波 pcm_s16le（避免全零被编码器特殊处理）。 */
function makePcm(seconds: number, rate: number): Buffer {
    const n = seconds * rate;
    const buf = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) {
        buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), i * 2);
    }
    return buf;
}

/** 生成单声道 16-bit PCM WAV（44 字节 RIFF 头）。 */
function makeWav(pcm: Buffer, rate: number): Buffer {
    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(rate, 24);
    header.writeUInt32LE(rate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36);
    header.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([header, pcm]);
}

describe("ensureSilk", () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "napuketto-adapter-media-"));
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it("已是 silk（#!SILK 头）→ 原样返回", async () => {
        const silk = join(dir, "voice.silk");
        writeFileSync(silk, Buffer.concat([Buffer.from("#!SILK_V3"), Buffer.alloc(16)]));

        await expect(ensureSilk(silk)).resolves.toBe(silk);
        expect(readFileSync(silk).subarray(0, 9).toString()).toBe("#!SILK_V3");
    });

    it("非 silk（单声道 WAV）→ 转码为 silk（生成 .silk 文件）", async () => {
        const wav = join(dir, "voice.wav");
        writeFileSync(wav, makeWav(makePcm(1, 24_000), 24_000));

        const out = await ensureSilk(wav);

        expect(out).not.toBe(wav);
        expect(basename(out)).toBe("voice.silk");
        // silk-wasm encode 输出带 1 字节 0x02 长度前缀（#!SILK_V3 在偏移 1），
        // 用 contains 而非前缀相等（对齐 silk-wasm isSilk 的判定）。
        expect(readFileSync(out).subarray(0, 10).toString()).toContain("#!SILK_V3");
    });

    it("文件不存在 → 原样返回（转码失败兜底）", async () => {
        const missing = join(dir, "missing.wav");
        await expect(ensureSilk(missing)).resolves.toBe(missing);
    });
});
