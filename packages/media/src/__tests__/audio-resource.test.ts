import {
    mkdtempSync,
    readdirSync,
    realpathSync,
    rmSync,
    truncateSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeSilkToPcm, decodeSilkToWav, encodePcmToSilk, getSilkInfo } from "../audio.js";
import { FFMPEG_WORK_OPTIONS, LOCAL_MEDIA_INPUT_OPTIONS } from "../process.js";
import { MediaError } from "../types.js";
import { makeWav, mockFfmpegChild } from "./test-support.js";

const { execaMock, encodeMock, decodeMock, terminated } = vi.hoisted(() => ({
    execaMock: vi.fn(),
    encodeMock: vi.fn(),
    decodeMock: vi.fn(),
    terminated: vi.fn(),
}));
vi.mock("execa", () => ({ execa: execaMock }));
vi.mock("node:worker_threads", async () => {
    const { EventEmitter } = await import("node:events");
    class Worker extends EventEmitter {
        constructor(
            _path: URL,
            { workerData }: { workerData: { mode: string; data: Buffer; sampleRate: number } },
        ) {
            super();
            const action = workerData.mode === "encode" ? encodeMock : decodeMock;
            Promise.resolve(action(workerData.data, workerData.sampleRate))
                .then((result: unknown) => {
                    this.emit("message", result);
                    this.emit("exit", 0);
                })
                .catch((error: unknown) => {
                    this.emit("error", error);
                    this.emit("exit", 1);
                });
        }
        async terminate(): Promise<number> {
            await new Promise<void>((resolve) => setImmediate(resolve));
            terminated();
            this.emit("exit", 1);
            return 1;
        }
    }
    // biome-ignore lint/style/useNamingConvention: Matches the Node.js export.
    return { Worker };
});

describe("H-02: 音频资源边界", () => {
    let dir: string;
    let input: string;
    beforeEach(() => {
        dir = realpathSync.native(mkdtempSync(join(tmpdir(), "nk-audio-limit-")));
        input = join(dir, "-压缩 音频.mp3");
        writeFileSync(input, "compressed");
        execaMock.mockReset();
        encodeMock.mockReset();
        decodeMock.mockReset();
        terminated.mockClear();
        encodeMock.mockResolvedValue({ data: new Uint8Array([1, 2]), duration: 1000 });
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    function normalizeBytes(size: number): void {
        execaMock.mockImplementation(() => mockFfmpegChild(size === 0 ? [] : [Buffer.alloc(size)]));
    }

    it("H-02: 归一化命令限制协议、格式、时间及落盘字节", async () => {
        normalizeBytes(48_000);
        await encodePcmToSilk(input);
        const args = execaMock.mock.calls[0]?.[1] as string[];
        expect(args).toEqual([
            "-nostdin",
            "-v",
            "error",
            ...FFMPEG_WORK_OPTIONS,
            ...LOCAL_MEDIA_INPUT_OPTIONS,
            "-i",
            input,
            "-map",
            "0:a:0",
            "-ac",
            "1",
            "-ar",
            "24000",
            "-t",
            "600.02",
            "-f",
            "s16le",
            "pipe:1",
        ]);
        expect(execaMock.mock.calls[0]?.[2]).toMatchObject({
            timeout: 120_000,
            forceKillAfterDelay: 1000,
            stdin: "ignore",
            maxBuffer: 1024 * 1024,
        });
        expect(encodeMock).toHaveBeenCalledWith(expect.any(Uint8Array), 24_000);
        expect(readdirSync(dir).filter((name) => name.startsWith(".napuketto-"))).toEqual([]);
    });

    it.each([0, 28_800_001, 32 * 1024 * 1024])(
        "H-02: 解码输出 %i 字节在读入编码器前拒绝且清理",
        async (size) => {
            normalizeBytes(size);
            await expect(encodePcmToSilk(input)).rejects.toThrow(MediaError);
            expect(encodeMock).not.toHaveBeenCalled();
            expect(readdirSync(dir)).toEqual(["-压缩 音频.mp3"]);
        },
    );

    it("H-02: 600s 的归一化 PCM 边界可编码", async () => {
        normalizeBytes(28_800_000);
        await encodePcmToSilk(input);
        expect(encodeMock).toHaveBeenCalledWith(
            expect.objectContaining({ byteLength: 28_800_000 }),
            24_000,
        );
    });

    it("H-02: 超时产生部分 PCM 后也清理，错误保留原因", async () => {
        execaMock.mockImplementation(() =>
            mockFfmpegChild([Buffer.from("partial")], { failed: true, timedOut: true }),
        );
        await expect(encodePcmToSilk(input)).rejects.toMatchObject({
            name: "MediaError",
            cause: { cause: { timedOut: true } },
        });
        expect(readdirSync(dir)).toEqual(["-压缩 音频.mp3"]);
        expect(encodeMock).not.toHaveBeenCalled();
    });

    it("H-02: 本地超大输入不绕过下载字节限制", async () => {
        truncateSync(input, 32 * 1024 * 1024 + 1);
        await expect(encodePcmToSilk(input)).rejects.toThrow(MediaError);
        expect(execaMock).not.toHaveBeenCalled();
        expect(encodeMock).not.toHaveBeenCalled();
    });

    it.each(["pcm", "wav"])("H-02: %s 直接编码也限制解码时长", async (format) => {
        const pcm = Buffer.alloc(601 * 8000 * 2);
        writeFileSync(input, format === "wav" ? makeWav({ rate: 8000, channels: 1 }, pcm) : pcm);
        await expect(encodePcmToSilk(input, format === "pcm" ? 8000 : 0)).rejects.toThrow(
            MediaError,
        );
        expect(encodeMock).not.toHaveBeenCalled();
        expect(execaMock).not.toHaveBeenCalled();
    });

    it.each([decodeSilkToPcm, decodeSilkToWav])(
        "H-02: 长 SILK 在 WASM 解码前拒绝",
        async (decodeAudio) => {
            writeFileSync(
                input,
                Buffer.concat([Buffer.from("#!SILK_V3"), Buffer.alloc(30_001 * 2)]),
            );
            await expect(decodeAudio(input)).rejects.toThrow(MediaError);
            expect(decodeMock).not.toHaveBeenCalled();
        },
    );

    it.each(["duration", "bytes"])("H-02: SILK 解码后 %s 越界不能落盘", async (limit) => {
        writeFileSync(input, Buffer.concat([Buffer.from("#!SILK_V3"), Buffer.from([1, 0, 0])]));
        decodeMock.mockResolvedValue({
            data: new Uint8Array(limit === "bytes" ? 28_800_001 : 2),
            duration: limit === "duration" ? 600_001 : 20,
        });
        await expect(decodeSilkToWav(input)).rejects.toThrow(MediaError);
        expect(readdirSync(dir)).toEqual(["-压缩 音频.mp3"]);
    });

    it("H-02: 无效采样率不进入 WASM", async () => {
        await expect(decodeSilkToPcm(input, 1_000_000)).rejects.toThrow(MediaError);
        await expect(encodePcmToSilk(input, 1_000_000)).rejects.toThrow(MediaError);
        expect(decodeMock).not.toHaveBeenCalled();
        expect(encodeMock).not.toHaveBeenCalled();
    });

    it("600s SILK 信息可以流式读取，增加一帧或截断最后一包时拒绝", async () => {
        const header = Buffer.from("#!SILK_V3");
        const frames = Buffer.from(new Uint8Array(30_000 * 3).map((_, i) => (i % 3 === 0 ? 1 : 0)));
        writeFileSync(input, Buffer.concat([header, frames, Buffer.from([0xff, 0xff])]));
        await expect(getSilkInfo(input)).resolves.toMatchObject({ durationMs: 600_000 });
        writeFileSync(input, Buffer.concat([header, frames, Buffer.from([1, 0, 0])]));
        await expect(getSilkInfo(input)).rejects.toThrow(/600s/);
        writeFileSync(input, Buffer.concat([header, frames.subarray(0, -1)]));
        await expect(getSilkInfo(input)).rejects.toThrow(/不完整/);
    });

    it("取消等待 Worker 退出并保留旧产物", async () => {
        writeFileSync(input, Buffer.concat([Buffer.from("#!SILK_V3"), Buffer.from([1, 0, 0])]));
        const old = join(dir, "-压缩 音频.wav");
        writeFileSync(old, "old");
        const controller = new AbortController();
        decodeMock.mockImplementation(() => {
            setImmediate(() => controller.abort());
            return new Promise(() => undefined);
        });
        await expect(decodeSilkToWav(input, { signal: controller.signal })).rejects.toThrow(/取消/);
        expect(terminated).toHaveBeenCalledOnce();
        expect(readdirSync(dir).sort()).toEqual(["-压缩 音频.mp3", "-压缩 音频.wav"]);
    });
});
