/**
 * video.ts 测试（execa 调外部 ffmpeg/ffprobe，全程 mock，不依赖真实二进制）
 *
 * 锁定：transcodeVideo 参数拼接（scale 组合 / fps / 输出路径替换扩展名）与
 * 失败路径（exitCode 非 0 / spawn 抛错 / 输出未生成）；getVideoInfo 的 JSON
 * 解析、字段缺失、exitCode 与非法输出；extractVideoFrame 参数与失败路径。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
        dir = mkdtempSync(join(tmpdir(), "nk-media-video-"));
        execaMock.mockReset();
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it("默认参数：-y -i 输入 + libx264 fast，输出为同目录替换 .mp4", async () => {
        mockSuccess();
        const input = join(dir, "clip.mov");

        const out = await transcodeVideo(input);

        expect(out).toBe(join(dir, "clip.mp4"));
        expect(execaMock).toHaveBeenCalledOnce();
        expect(execaMock.mock.calls[0]?.[0]).toBe("ffmpeg");
        expect(execaMock.mock.calls[0]?.[1]).toEqual([
            "-y",
            "-i",
            input,
            "-c:v",
            "libx264",
            "-preset",
            "fast",
            join(dir, "clip.mp4"),
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

        expect(out).toBe(join(dir, "clip.mp4"));
    });

    it("多点扩展名输入 → 只替换最后一段", async () => {
        mockSuccess();
        const input = join(dir, "a.b.mov");

        const out = await transcodeVideo(input);

        expect(out).toBe(join(dir, "a.b.mp4"));
    });

    it("裸文件名（无目录分隔符）→ 输出落在同目录位置（replaceExt 无 dir 分支）", async () => {
        // 不写输出文件（exit 0 但文件缺失会抛 MediaError），只断言拼出的输出参数
        execaMock.mockResolvedValue({ exitCode: 0, stdout: "" });

        await expect(transcodeVideo("clip.mov")).rejects.toThrow(/ffmpeg 转码失败/);
        const args = execaMock.mock.calls[0]?.[1] as string[];
        expect(args.at(-1)).toBe("clip.mp4");
    });

    it("exitCode 非 0 → MediaError（ffmpeg 转码失败，含 exit 码）", async () => {
        execaMock.mockResolvedValue({ exitCode: 1, stdout: "" });

        await expect(transcodeVideo(join(dir, "a.mov"))).rejects.toThrow(MediaError);
        await expect(transcodeVideo(join(dir, "a.mov"))).rejects.toThrow(/exit 1/);
    });

    it("exitCode 0 但输出文件未生成 → MediaError（不返回幽灵路径）", async () => {
        execaMock.mockResolvedValue({ exitCode: 0, stdout: "" });

        await expect(transcodeVideo(join(dir, "a.mov"))).rejects.toThrow(/ffmpeg 转码失败/);
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
        dir = mkdtempSync(join(tmpdir(), "nk-media-probe-"));
        execaMock.mockReset();
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
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            join(dir, "a.mp4"),
        ]);
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
        dir = mkdtempSync(join(tmpdir(), "nk-media-frame-"));
        execaMock.mockReset();
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it("固定 -ss 0 取首帧，参数含 -frames:v 1 / -q:v 3 / -f image2", async () => {
        mockSuccess();
        const input = join(dir, "a.mp4");
        const output = join(dir, "thumb.png");

        const out = await extractVideoFrame(input, output);

        expect(out).toBe(output);
        expect(execaMock.mock.calls[0]?.[0]).toBe("ffmpeg");
        expect(execaMock.mock.calls[0]?.[1]).toEqual([
            "-y",
            "-ss",
            "0",
            "-i",
            input,
            "-frames:v",
            "1",
            "-q:v",
            "3",
            "-f",
            "image2",
            output,
        ]);
    });

    it("exitCode 非 0 → MediaError（ffmpeg 抽帧失败）", async () => {
        execaMock.mockResolvedValue({ exitCode: 1, stdout: "" });

        await expect(extractVideoFrame(join(dir, "a.mp4"), join(dir, "t.png"))).rejects.toThrow(
            /ffmpeg 抽帧失败/,
        );
    });

    it("exitCode 0 但输出未生成 → MediaError", async () => {
        execaMock.mockResolvedValue({ exitCode: 0, stdout: "" });

        await expect(extractVideoFrame(join(dir, "a.mp4"), join(dir, "t.png"))).rejects.toThrow(
            /ffmpeg 抽帧失败/,
        );
    });

    it("spawn 失败 → MediaError（ffmpeg 不可用或抽帧失败）", async () => {
        execaMock.mockRejectedValue(new Error("spawn ffmpeg ENOENT"));

        await expect(extractVideoFrame(join(dir, "a.mp4"), join(dir, "t.png"))).rejects.toThrow(
            /ffmpeg 不可用或抽帧失败/,
        );
    });
});
