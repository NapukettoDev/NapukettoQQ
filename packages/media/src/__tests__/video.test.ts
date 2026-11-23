import {
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    truncateSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCAL_MEDIA_INPUT_OPTIONS } from "../process.js";
import { MediaError } from "../types.js";
import { extractVideoFrame, getVideoInfo, transcodeVideo } from "../video.js";
import { mockFfmpegChild } from "./test-support.js";

const { execaMock } = vi.hoisted(() => ({ execaMock: vi.fn() }));
vi.mock("execa", () => ({ execa: execaMock }));

const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/6X2uZkAAAAASUVORK5CYII=",
    "base64",
);

function probe(stream: Record<string, unknown> = {}, duration = "1.25") {
    return {
        exitCode: 0,
        stdout: JSON.stringify({
            streams: [
                {
                    width: 640,
                    height: 360,
                    avg_frame_rate: "30/1",
                    codec_name: "h264",
                    nb_read_packets: "37",
                    ...stream,
                },
            ],
            format: { duration, format_name: "mov,mp4,m4a,3gp,3g2,mj2" },
        }),
    };
}

function mockVideo(
    streamOutput: () => ReturnType<typeof mockFfmpegChild> = () =>
        mockFfmpegChild([Buffer.from("fake-output")]),
    inputProbe = probe(),
): void {
    let output = probe();
    execaMock.mockImplementation((command: string, args: string[]) => {
        if (command === "ffprobe") return args.includes("-count_packets") ? output : inputProbe;
        const filters = args[args.indexOf("-vf") + 1] ?? "";
        const scale = filters.split(",").at(-1) ?? "";
        const [width, height] = scale.slice("scale=".length).split(":").map(Number);
        output = probe({ width, height });
        return streamOutput();
    });
}

let dir: string;
let input: string;
beforeEach(() => {
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), "nk-media-video-")));
    input = join(dir, "clip.mov");
    writeFileSync(input, "original");
    execaMock.mockReset();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function ffmpegCall() {
    const [, args, options] = execaMock.mock.calls.find(([command]) => command === "ffmpeg") ?? [];
    return { args: args as string[], options: options as object };
}

describe("transcodeVideo", () => {
    it.each([
        [{}, "scale=640:360"],
        [{ width: 640, height: 360 }, "scale=640:360"],
        [{ width: 480 }, "scale=480:270"],
        [{ height: 720 }, "scale=1280:720"],
    ])("计算有界的输出尺寸 %j", async (options, scale) => {
        mockVideo();
        const result = await transcodeVideo(input, options);
        expect(dirname(dirname(result))).toBe(dir);
        expect(basename(result)).toBe("output.mp4");
        expect(ffmpegCall().args).toContain(scale);
    });

    it("实际参数限制输入协议、解码工作量、编码帧与过程期限", async () => {
        mockVideo();
        await transcodeVideo(input, { fps: 30 });
        const { args, options } = ffmpegCall();
        expect(args.slice(args.indexOf("-protocol_whitelist"), args.indexOf("-i"))).toEqual(
            LOCAL_MEDIA_INPUT_OPTIONS,
        );
        expect(args[args.indexOf("-i") + 1]).toBe(input);
        expect(args.slice(args.indexOf("-vf"), args.indexOf("-c:v"))).toEqual([
            "-vf",
            "fps=30:eof_action=pass,scale=640:360",
            "-frames:v",
            "81001",
            "-t",
            "601",
        ]);
        expect(args).toEqual(expect.arrayContaining(["libx264", "fast", "yuv420p", "128k", "8M"]));
        expect(args.slice(-3)).toEqual(["-f", "mp4", "pipe:1"]);
        expect(execaMock.mock.calls[2]?.[1]).toContain("-count_packets");
        expect(options).toMatchObject({
            timeout: 300_000,
            killSignal: "SIGTERM",
            forceKillAfterDelay: 1000,
            stdin: "ignore",
            maxBuffer: 1024 * 1024,
            cleanup: true,
            windowsHide: true,
            buffer: { stdout: false },
        });
    });

    it("低帧率分片 MP4 使用探测到的平均帧率核验产物", async () => {
        execaMock
            .mockResolvedValueOnce(probe())
            .mockImplementationOnce(() => mockFfmpegChild([Buffer.from("fake-output")]))
            .mockResolvedValueOnce(probe({ avg_frame_rate: "1/1", r_frame_rate: "2/1" }));
        await expect(transcodeVideo(input, { fps: 1 })).resolves.toMatch(/output\.mp4$/);
    });

    it("H-02: 相对连字符文件名使用绝对路径，无扩展名也能生成独占产物", async () => {
        const name = `-nk-media-${process.pid}`;
        writeFileSync(name, "original", { flag: "wx" });
        mockVideo();
        let out: string | undefined;
        try {
            out = await transcodeVideo(name);
            const { args } = ffmpegCall();
            expect(args[args.indexOf("-i") + 1]).toBe(resolve(name));
            expect(isAbsolute(out)).toBe(true);
        } finally {
            rmSync(name, { force: true });
            if (out !== undefined) {
                rmSync(out, { force: true });
                rmSync(dirname(out), { recursive: true, force: true });
            }
        }
    });

    it("H-02: 并发转码保护源文件及同名 mp4", async () => {
        mockVideo();
        const existing = join(dir, "clip.mp4");
        writeFileSync(existing, "existing");
        const outputs = await Promise.all([transcodeVideo(input), transcodeVideo(input)]);
        expect(new Set(outputs).size).toBe(2);
        for (const output of outputs) expect(readFileSync(output, "utf8")).toBe("fake-output");
        expect(readFileSync(input, "utf8")).toBe("original");
        expect(readFileSync(existing, "utf8")).toBe("existing");
    });

    it.each(["exit", "timeout", "spawn", "empty", "oversize", "invalid output"])(
        "失败 %s 保留原文件并清理部分输出",
        async (failure) => {
            const partial = Buffer.from("partial");
            mockVideo(() => {
                if (failure === "spawn") throw new Error("ENOENT");
                if (failure === "empty") return mockFfmpegChild([]);
                if (failure === "oversize") {
                    const chunk = Buffer.alloc(1024 * 1024);
                    return mockFfmpegChild(Array.from({ length: 129 }, () => chunk));
                }
                if (failure === "timeout")
                    return mockFfmpegChild([partial], { failed: true, timedOut: true });
                if (failure === "exit") return mockFfmpegChild([partial], { exitCode: 1 });
                execaMock.mockImplementationOnce(() => probe({ nb_read_packets: "81001" }));
                return mockFfmpegChild([partial]);
            });
            await expect(transcodeVideo(input)).rejects.toThrow(MediaError);
            expect(readFileSync(input, "utf8")).toBe("original");
            expect(readdirSync(dir)).toEqual([basename(input)]);
        },
    );

    it("取消等待子进程退出并删除已写出的部分", async () => {
        const stop = new AbortController();
        let exited = false;
        execaMock.mockImplementation(
            (command: string, _args: string[], options: { cancelSignal: AbortSignal }) => {
                if (command === "ffprobe") return probe();
                const stdout = new PassThrough();
                stdout.write("partial");
                return Object.assign(
                    new Promise((done) => {
                        options.cancelSignal.addEventListener("abort", () => {
                            setImmediate(() => {
                                exited = true;
                                stdout.end();
                                done({ failed: true });
                            });
                        });
                        setImmediate(() => stop.abort());
                    }),
                    { stdout },
                );
            },
        );
        await expect(transcodeVideo(input, { signal: stop.signal })).rejects.toThrow(/取消/);
        expect(exited).toBe(true);
        expect(readdirSync(dir)).toEqual([basename(input)]);
    });

    it.each([
        { width: 3 },
        { width: -2 },
        { height: 4098 },
        { fps: NaN },
        { fps: Infinity },
        { fps: 61 },
    ])("拒绝越界的转码参数 %j", async (options) => {
        await expect(transcodeVideo(input, options)).rejects.toThrow(MediaError);
        expect(execaMock).not.toHaveBeenCalled();
    });

    it.each([
        "https://example.com/a.mp4",
        "pipe:0",
        "concat:a|b",
        "file:a.mp4",
        "\\\\server\\share\\a.mp4",
        "//server/share/a.mp4",
    ])("H-02: 非本地输入 %s 不启动进程", async (source) => {
        await expect(transcodeVideo(source)).rejects.toThrow(MediaError);
        expect(execaMock).not.toHaveBeenCalled();
    });

    it("拒绝超大输入和过高像素帧工作量", async () => {
        mockVideo(undefined, probe({ width: 1920, height: 1080 }, "300.034"));
        await expect(transcodeVideo(input)).rejects.toThrow(/像素帧/);
        expect(execaMock).toHaveBeenCalledTimes(1);
        truncateSync(input, 128 * 1024 * 1024 + 1);
        await expect(transcodeVideo(input)).rejects.toThrow(/大小限制/);
        expect(execaMock).toHaveBeenCalledTimes(1);
    });
});

describe("getVideoInfo", () => {
    it("核验主视频流、显示方向与毫秒精度", async () => {
        execaMock.mockResolvedValue(probe({ side_data_list: [{ rotation: -90 }] }, "0.1236"));
        await expect(getVideoInfo(input)).resolves.toEqual({
            width: 360,
            height: 640,
            durationMs: 124,
        });
        expect(execaMock.mock.calls[0]?.[0]).toBe("ffprobe");
        expect(execaMock.mock.calls[0]?.[1]).toEqual(
            expect.arrayContaining([
                "-protocol_whitelist",
                "file",
                "-select_streams",
                "V:0",
                "-show_entries",
            ]),
        );
        expect(execaMock.mock.calls[0]?.[2]).toMatchObject({
            timeout: 15_000,
            forceKillAfterDelay: 1000,
        });
    });

    it.each([
        probe({ width: 0 }),
        probe({ width: 4096, height: 4096 }),
        probe({ height: 4100 }),
        probe({ avg_frame_rate: "61/1" }),
        probe({}, "0"),
        probe({}, "N/A"),
        probe({}, "600.001"),
        { exitCode: 0, stdout: "{broken" },
        { exitCode: 0, stdout: "{}" },
        { exitCode: 2, stdout: "" },
    ])("无效的探测结果拒绝", async (result) => {
        execaMock.mockResolvedValue(result);
        await expect(getVideoInfo(input)).rejects.toThrow(MediaError);
    });

    it("输入时长、帧率、像素与字节上限包含边界", async () => {
        truncateSync(input, 128 * 1024 * 1024);
        execaMock.mockResolvedValue(
            probe({ width: 3840, height: 2160, avg_frame_rate: "60/1" }, "600"),
        );
        await expect(getVideoInfo(input)).resolves.toEqual({
            width: 3840,
            height: 2160,
            durationMs: 600_000,
        });
    });
});

describe("extractVideoFrame", () => {
    it("H-02: 同路径抽帧拒绝启动，包括 Windows 短路径别名", async () => {
        await expect(
            extractVideoFrame(input, join(tmpdir(), basename(dir), basename(input))),
        ).rejects.toThrow(MediaError);
        expect(execaMock).not.toHaveBeenCalled();
        expect(readFileSync(input, "utf8")).toBe("original");
    });

    it("抽首帧 PNG，校验后移动到调用者指定路径", async () => {
        execaMock.mockImplementation(() => mockFfmpegChild([PNG]));
        const output = join(dir, "thumb.png");
        await expect(extractVideoFrame(input, output)).resolves.toBe(output);
        expect(readFileSync(output)).toEqual(PNG);
        const { args, options } = ffmpegCall();
        expect(args).toEqual(
            expect.arrayContaining([
                "-ss",
                "0",
                "-frames:v",
                "1",
                "-c:v",
                "png",
                "-f",
                "image2pipe",
                "pipe:1",
            ]),
        );
        expect(options).toMatchObject({ timeout: 30_000 });
        expect(readdirSync(dir).sort()).toEqual([basename(input), "thumb.png"]);
    });

    it.each([
        { bytes: [Buffer.from("partial")], result: { failed: true, timedOut: true } },
        { bytes: [], result: { exitCode: 1 } },
        { bytes: [], result: { exitCode: 0 } },
        { bytes: [Buffer.from("garbage")], result: { exitCode: 0 } },
    ])("抽帧失败清理临时文件并保留旧缩略图", async ({ bytes, result }) => {
        execaMock.mockImplementation(() => mockFfmpegChild(bytes, result));
        const target = join(dir, "thumb.png");
        writeFileSync(target, "old thumbnail");
        await expect(extractVideoFrame(input, target)).rejects.toThrow(MediaError);
        expect(readFileSync(target, "utf8")).toBe("old thumbnail");
        expect(readdirSync(dir).sort()).toEqual([basename(input), basename(target)]);
    });
});
