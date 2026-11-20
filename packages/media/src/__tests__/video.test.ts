/**
 * video.ts 测试（execa 调外部 ffmpeg/ffprobe，全程 mock，不依赖真实二进制）
 *
 * 锁定：transcodeVideo 参数拼接（scale 组合 / fps / 输出路径替换扩展名）与
 * 失败路径（exitCode 非 0 / spawn 抛错 / 输出未生成）；getVideoInfo 的 JSON
 * 解析、字段缺失、exitCode 与非法输出；extractVideoFrame 参数与失败路径。
 */
import {
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCAL_MEDIA_INPUT_OPTIONS } from "../process.js";
import { MediaError } from "../types.js";
import { extractVideoFrame, getVideoInfo, transcodeVideo } from "../video.js";

const { execaMock } = vi.hoisted(() => ({ execaMock: vi.fn() }));
vi.mock("execa", () => ({ execa: execaMock }));

/** 让 mock execa 成功并在最后一个参数（输出路径）写入占位文件。 */
function mockSuccess(): void {
    execaMock.mockImplementation(async (_cmd: string, args: string[]) => {
        const out = args.at(-1);
        if (out === undefined) {
            throw new Error("ffmpeg mock：缺输出路径参数");
        }
        writeFileSync(out, "fake-output");
        return { exitCode: 0, stdout: "" };
    });
}

describe("transcodeVideo", () => {
    let dir: string;
    beforeEach(() => {
        dir = realpathSync.native(mkdtempSync(join(tmpdir(), "nk-media-video-")));
        execaMock.mockReset();
        for (const name of ["a.mp4", "a.mov", "clip.mov", "clip", "a.b.mov"]) {
            writeFileSync(join(dir, name), "original");
        }
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it("默认参数：-y -i 输入 + libx264 fast，输出为同目录替换 .mp4", async () => {
        mockSuccess();
        const input = join(dir, "clip.mov");

        const out = await transcodeVideo(input);

        expect(dirname(dirname(out))).toBe(dir);
        expect(out).toMatch(/output\.mp4$/);
        expect(execaMock).toHaveBeenCalledOnce();
        expect(execaMock.mock.calls[0]?.[0]).toBe("ffmpeg");
        expect(execaMock.mock.calls[0]?.[1]).toEqual([
            "-nostdin",
            "-v",
            "error",
            "-y",
            ...LOCAL_MEDIA_INPUT_OPTIONS,
            "-i",
            input,
            "-c:v",
            "libx264",
            "-preset",
            "fast",
            out,
        ]);
    });

    it("width + height → -vf scale=W:H", async () => {
        mockSuccess();
        const input = join(dir, "clip.mov");

        await transcodeVideo(input, { width: 640, height: 360 });

        const args = execaMock.mock.calls[0]?.[1] as string[];
        expect(args).toContain("-vf");
        expect(args).toContain("scale=640:360");
    });

    it("仅 width → scale=W:-2（高度自动取偶）", async () => {
        mockSuccess();

        await transcodeVideo(join(dir, "a.mp4"), { width: 480 });

        const args = execaMock.mock.calls[0]?.[1] as string[];
        expect(args).toContain("scale=480:-2");
    });

    it("仅 height → scale=-2:H（宽度自动取偶）", async () => {
        mockSuccess();

        await transcodeVideo(join(dir, "a.mp4"), { height: 720 });

        const args = execaMock.mock.calls[0]?.[1] as string[];
        expect(args).toContain("scale=-2:720");
    });

    it("fps → -r 30", async () => {
        mockSuccess();

        await transcodeVideo(join(dir, "a.mp4"), { fps: 30 });

        const args = execaMock.mock.calls[0]?.[1] as string[];
        expect(args).toContain("-r");
        expect(args).toContain("30");
    });

    it("无扩展名输入 → 输出补 .mp4", async () => {
        mockSuccess();
        const input = join(dir, "clip");

        const out = await transcodeVideo(input);

        expect(dirname(dirname(out))).toBe(dir);
        expect(out).toMatch(/output\.mp4$/);
    });

    it("多点扩展名输入 → 只替换最后一段", async () => {
        mockSuccess();
        const input = join(dir, "a.b.mov");

        const out = await transcodeVideo(input);

        expect(dirname(dirname(out))).toBe(dir);
        expect(out).toMatch(/output\.mp4$/);
    });

    it("H-02: 连字符开头的相对文件名转换为绝对路径", async () => {
        const name = `-nk-media-${Date.now()}.mov`;
        writeFileSync(name, "original");
        mockSuccess();
        let out: string | undefined;
        try {
            out = await transcodeVideo(name);
            const args = execaMock.mock.calls[0]?.[1] as string[];
            expect(args[args.indexOf("-i") + 1]).toBe(resolve(name));
            expect(isAbsolute(out)).toBe(true);
        } finally {
            rmSync(name, { force: true });
            if (out !== undefined && basename(dirname(out)).startsWith(".napuketto-video-")) {
                rmSync(dirname(out), { recursive: true, force: true });
            } else if (out !== undefined) {
                rmSync(out, { force: true });
            }
        }
    });

    it("H-02: mp4 输入不被覆盖，已有同名输出不被覆盖，并发输出独立", async () => {
        mockSuccess();
        const input = join(dir, "a.mp4");
        const outputs = await Promise.all([transcodeVideo(input), transcodeVideo(input)]);
        expect(new Set(outputs).size).toBe(2);
        for (const output of outputs) {
            expect(output).not.toBe(input);
            expect(readFileSync(output, "utf8")).toBe("fake-output");
        }
        expect(readFileSync(input, "utf8")).toBe("original");
        await transcodeVideo(join(dir, "a.mov"));
        expect(readFileSync(input, "utf8")).toBe("original");
    });

    it.each(["exit", "timeout", "spawn", "empty", "missing"])(
        "H-02: %s 失败保留原文件并清理部分输出",
        async (failure) => {
            const timedOut = failure === "timeout";
            const exitCode = failure === "exit" ? 1 : 0;
            const content = failure === "empty" ? "" : "partial";
            execaMock.mockImplementation(async (_cmd: string, args: string[]) => {
                const out = args.at(-1);
                if (out === undefined) throw new Error("missing output");
                if (failure !== "missing") writeFileSync(out, content);
                if (failure === "spawn") throw new Error("ENOENT");
                return {
                    exitCode: timedOut ? undefined : exitCode,
                    timedOut,
                    failed: timedOut,
                };
            });
            await expect(transcodeVideo(join(dir, "a.mp4"))).rejects.toThrow(MediaError);
            expect(readFileSync(join(dir, "a.mp4"), "utf8")).toBe("original");
            expect(readdirSync(dir).filter((name) => name.startsWith(".napuketto-"))).toEqual([]);
        },
    );

    it("H-02: 转码输入协议、格式、期限与终止契约", async () => {
        mockSuccess();
        await transcodeVideo(join(dir, "a.mov"));
        expect(execaMock.mock.calls[0]?.[2]).toMatchObject({
            timeout: 300_000,
            killSignal: "SIGTERM",
            forceKillAfterDelay: 1000,
            stdin: "ignore",
            maxBuffer: 1024 * 1024,
            cleanup: true,
            windowsHide: true,
        });
        const args = execaMock.mock.calls[0]?.[1] as string[];
        expect(args[args.indexOf("-protocol_whitelist") + 1]).toBe("file");
        const formats = args[args.indexOf("-format_whitelist") + 1]?.split(",");
        expect(formats).toEqual(
            expect.arrayContaining(["mov", "matroska", "wav", "mp3", "amr", "flac"]),
        );
        for (const format of ["hls", "dash", "concat", "sdp", "image2", "sbg", "vapoursynth"]) {
            expect(formats).not.toContain(format);
        }
        expect(args.indexOf("-protocol_whitelist")).toBeLessThan(args.indexOf("-i"));
    });

    it.each([
        "https://example.com/a.mp4",
        "pipe:0",
        "concat:a|b",
        "file:a.mp4",
        "\\\\server\\share\\a.mp4",
        "//server/share/a.mp4",
    ])("H-02: 非本地输入 %s 不启动进程", async (input) => {
        await expect(transcodeVideo(input)).rejects.toThrow(MediaError);
        expect(execaMock).not.toHaveBeenCalled();
    });

    it("exitCode 非 0 → MediaError（ffmpeg 转码失败，含 exit 码）", async () => {
        execaMock.mockResolvedValue({ exitCode: 1, stdout: "" });

        await expect(transcodeVideo(join(dir, "a.mov"))).rejects.toThrow(MediaError);
        await expect(transcodeVideo(join(dir, "a.mov"))).rejects.toThrow(/exit 1/);
    });

    it("exitCode 0 但输出文件未生成 → MediaError（不返回幽灵路径）", async () => {
        execaMock.mockResolvedValue({ exitCode: 0, stdout: "" });

        await expect(transcodeVideo(join(dir, "a.mov"))).rejects.toThrow(/转码失败|媒体输出/);
    });

    it("spawn 失败（ffmpeg 缺失）→ MediaError 且保留 cause", async () => {
        const cause = new Error("spawn ffmpeg ENOENT");
        execaMock.mockRejectedValue(cause);

        const err = await transcodeVideo(join(dir, "a.mov")).catch((e: unknown) => e);
        expect(err instanceof MediaError).toBe(true);
        expect((err as MediaError).message).toContain("ffmpeg 不可用或转码失败");
        expect((err as MediaError).cause).toBe(cause);
    });
});

describe("getVideoInfo", () => {
    let dir: string;
    beforeEach(() => {
        dir = realpathSync.native(mkdtempSync(join(tmpdir(), "nk-media-probe-")));
        execaMock.mockReset();
        for (const name of ["a.mp4", "a.mov", "clip.mov", "clip", "a.b.mov"]) {
            writeFileSync(join(dir, name), "original");
        }
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it("解析 ffprobe JSON：宽高 + duration 秒转毫秒", async () => {
        execaMock.mockResolvedValue({
            exitCode: 0,
            stdout: JSON.stringify({
                streams: [
                    { codec_type: "audio", width: 1, height: 1 },
                    { codec_type: "video", width: 640, height: 360 },
                ],
                format: { duration: "1.25" },
            }),
        });

        const info = await getVideoInfo(join(dir, "a.mp4"));

        expect(info).toEqual({ width: 640, height: 360, durationMs: 1250 });
        expect(execaMock.mock.calls[0]?.[0]).toBe("ffprobe");
        expect(execaMock.mock.calls[0]?.[1]).toEqual([
            "-v",
            "error",
            ...LOCAL_MEDIA_INPUT_OPTIONS,
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            "-i",
            join(dir, "a.mp4"),
        ]);
    });

    it("H-02: 探测也使用输入限制与执行期限", async () => {
        execaMock.mockResolvedValue({ exitCode: undefined, timedOut: true });
        await expect(getVideoInfo(join(dir, "a.mp4"))).rejects.toThrow(MediaError);
        expect(execaMock.mock.calls[0]?.[2]).toMatchObject({
            timeout: 15_000,
            forceKillAfterDelay: 1000,
            stdin: "ignore",
        });
        const args = execaMock.mock.calls[0]?.[1] as string[];
        expect(args).toContain("-protocol_whitelist");
        expect(args).toContain("file");
        expect(args).toContain("-format_whitelist");
    });

    it("duration 为小数秒时四舍五入到毫秒", async () => {
        execaMock.mockResolvedValue({
            exitCode: 0,
            stdout: JSON.stringify({
                streams: [{ codec_type: "video", width: 10, height: 10 }],
                format: { duration: "0.1236" },
            }),
        });

        expect(await getVideoInfo(join(dir, "a.mp4"))).toEqual({
            width: 10,
            height: 10,
            durationMs: 124,
        });
    });

    it("exitCode 非 0 → MediaError（exit 码透出，不被外层 catch 吞掉）", async () => {
        execaMock.mockResolvedValue({ exitCode: 2, stdout: "" });

        await expect(getVideoInfo(join(dir, "a.mp4"))).rejects.toThrow(/exit 2/);
    });

    it("stdout 非法 JSON → MediaError（解析失败包装）", async () => {
        execaMock.mockResolvedValue({ exitCode: 0, stdout: "{broken" });

        await expect(getVideoInfo(join(dir, "a.mp4"))).rejects.toThrow(/ffprobe 读取失败/);
    });

    it("缺 width / height / duration 任一项 → MediaError（未取到视频信息）", async () => {
        execaMock.mockResolvedValue({
            exitCode: 0,
            stdout: JSON.stringify({
                streams: [{ codec_type: "video" }],
                format: { duration: "1" },
            }),
        });
        await expect(getVideoInfo(join(dir, "a.mp4"))).rejects.toThrow(/未取到视频信息/);

        execaMock.mockResolvedValue({
            exitCode: 0,
            stdout: JSON.stringify({
                streams: [{ codec_type: "video", width: 1, height: 1 }],
                format: {},
            }),
        });
        await expect(getVideoInfo(join(dir, "a.mp4"))).rejects.toThrow(/未取到视频信息/);
    });

    it("无 video 流 → MediaError", async () => {
        execaMock.mockResolvedValue({
            exitCode: 0,
            stdout: JSON.stringify({
                streams: [{ codec_type: "audio", width: 1, height: 1 }],
                format: { duration: "1" },
            }),
        });

        await expect(getVideoInfo(join(dir, "a.mp4"))).rejects.toThrow(/未取到视频信息/);
    });

    it("spawn 失败 → MediaError 且保留 cause", async () => {
        const cause = new Error("spawn ffprobe ENOENT");
        execaMock.mockRejectedValue(cause);

        const err = await getVideoInfo(join(dir, "a.mp4")).catch((e: unknown) => e);
        expect(err instanceof MediaError).toBe(true);
        expect((err as MediaError).cause).toBe(cause);
    });
});

describe("extractVideoFrame", () => {
    let dir: string;
    beforeEach(() => {
        dir = realpathSync.native(mkdtempSync(join(tmpdir(), "nk-media-frame-")));
        execaMock.mockReset();
        for (const name of ["a.mp4", "a.mov", "clip.mov", "clip", "a.b.mov"]) {
            writeFileSync(join(dir, name), "original");
        }
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it("H-02: 同路径抽帧拒绝启动，兼容 Windows 短路径别名", async () => {
        const input = join(dir, "a.mp4");
        const alias = join(tmpdir(), basename(dir), "a.mp4");
        await expect(extractVideoFrame(input, alias)).rejects.toThrow(MediaError);
        expect(execaMock).not.toHaveBeenCalled();
        expect(readFileSync(input, "utf8")).toBe("original");
    });

    it("固定 -ss 0 取首帧，参数含 -frames:v 1 / -q:v 3 / -f image2", async () => {
        mockSuccess();
        const input = join(dir, "a.mp4");
        const output = join(dir, "thumb.png");

        const out = await extractVideoFrame(input, output);

        expect(out).toBe(output);
        expect(execaMock.mock.calls[0]?.[0]).toBe("ffmpeg");
        expect(execaMock.mock.calls[0]?.[1]).toEqual([
            "-nostdin",
            "-v",
            "error",
            "-y",
            "-ss",
            "0",
            ...LOCAL_MEDIA_INPUT_OPTIONS,
            "-i",
            input,
            "-frames:v",
            "1",
            "-q:v",
            "3",
            "-f",
            "image2",
            expect.stringMatching(/frame\.png$/),
        ]);
    });

    it("H-02: 抽帧失败清理临时文件，保留已有缩略图", async () => {
        const target = join(dir, "t.png");
        writeFileSync(target, "old thumbnail");
        execaMock.mockImplementation(async (_cmd: string, args: string[]) => {
            const out = args.at(-1);
            if (out !== undefined) writeFileSync(out, "partial");
            return { exitCode: undefined, timedOut: true };
        });
        await expect(extractVideoFrame(join(dir, "a.mp4"), target)).rejects.toThrow(MediaError);
        expect(readFileSync(target, "utf8")).toBe("old thumbnail");
        expect(readdirSync(dir).filter((name) => name.startsWith(".napuketto-"))).toEqual([]);
        expect(execaMock.mock.calls[0]?.[2]).toMatchObject({ timeout: 30_000 });
    });

    it("exitCode 非 0 → MediaError（ffmpeg 抽帧失败）", async () => {
        execaMock.mockResolvedValue({ exitCode: 1, stdout: "" });

        await expect(extractVideoFrame(join(dir, "a.mp4"), join(dir, "t.png"))).rejects.toThrow(
            /抽帧失败|媒体输出/,
        );
    });

    it("exitCode 0 但输出未生成 → MediaError", async () => {
        execaMock.mockResolvedValue({ exitCode: 0, stdout: "" });

        await expect(extractVideoFrame(join(dir, "a.mp4"), join(dir, "t.png"))).rejects.toThrow(
            /抽帧失败|媒体输出/,
        );
    });

    it("spawn 失败 → MediaError（ffmpeg 不可用或抽帧失败）", async () => {
        execaMock.mockRejectedValue(new Error("spawn ffmpeg ENOENT"));

        await expect(extractVideoFrame(join(dir, "a.mp4"), join(dir, "t.png"))).rejects.toThrow(
            /ffmpeg 不可用或抽帧失败/,
        );
    });
});
