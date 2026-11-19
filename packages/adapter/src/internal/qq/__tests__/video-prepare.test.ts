/**
 * prepareVideoElements：发送侧视频缩略图归一化测试
 *
 * ffmpeg/ffprobe 全部 mock（Windows CI 没有 ffmpeg）：断言「缺缩略图的视频
 * 被补上 thumbPath/宽高/时长、临时目录由 cleanup 删除、已有缩略图与非视频
 * 元素原样穿过、抽帧失败时清理后抛出」。
 */
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const media = vi.hoisted(() => ({
    getVideoInfo: vi.fn(),
    extractVideoFrame: vi.fn(),
}));

vi.mock("@napuketto/media", async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    getVideoInfo: media.getVideoInfo,
    extractVideoFrame: media.extractVideoFrame,
}));

import { prepareVideoElements } from "../media.js";

let dir = "";

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "napuketto-video-test-"));
    media.getVideoInfo.mockResolvedValue({ width: 64, height: 48, durationMs: 1600 });
    // 抽帧桩：写出占位文件，返回输出路径
    media.extractVideoFrame.mockImplementation(async (_input: string, output: string) => {
        writeFileSync(output, Buffer.from("thumb-bytes"));
        return output;
    });
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    media.getVideoInfo.mockReset();
    media.extractVideoFrame.mockReset();
});

describe("prepareVideoElements", () => {
    it("缺缩略图的视频 → 补 thumbPath（临时目录内）+ 宽高 + 时长（秒）", async () => {
        const video = join(dir, "clip.mp4");
        writeFileSync(video, Buffer.from("mp4"));

        const prepared = await prepareVideoElements([{ type: "video", path: video }]);
        const el = prepared.elements[0];

        expect(el).toMatchObject({
            type: "video",
            path: video,
            width: 64,
            height: 48,
            durationSec: 2,
        });
        const thumbPath = (el as { thumbPath?: string }).thumbPath ?? "";
        expect(thumbPath.endsWith(".png")).toBe(true);
        expect(existsSync(thumbPath)).toBe(true);
        expect(media.getVideoInfo).toHaveBeenCalledWith(video);
        expect(media.extractVideoFrame).toHaveBeenCalledTimes(1);

        // cleanup 删掉临时缩略图目录
        const thumbDir = dirname(thumbPath);
        await prepared.cleanup();
        expect(existsSync(thumbDir)).toBe(false);
    });

    it("已有 thumbPath / 非视频元素 → 原样穿过，不调用 ffmpeg", async () => {
        const prepared = await prepareVideoElements([
            { type: "text", text: "hi" },
            { type: "video", path: join(dir, "v.mp4"), thumbPath: join(dir, "cover.png") },
        ]);

        expect(prepared.elements).toEqual([
            { type: "text", text: "hi" },
            { type: "video", path: join(dir, "v.mp4"), thumbPath: join(dir, "cover.png") },
        ]);
        expect(media.getVideoInfo).not.toHaveBeenCalled();
        expect(media.extractVideoFrame).not.toHaveBeenCalled();
        // 没有缩略图 → cleanup 是 no-op（不抛错）
        await expect(prepared.cleanup()).resolves.toBeUndefined();
    });

    it("抽帧失败 → 清理临时目录后抛出（不让 native 回 sendStatus=0）", async () => {
        media.extractVideoFrame.mockRejectedValue(new Error("ffmpeg 抽帧失败"));

        await expect(
            prepareVideoElements([{ type: "video", path: join(dir, "broken.mp4") }]),
        ).rejects.toThrow(/ffmpeg 抽帧失败/);

        // 临时目录已清理：系统 tmp 里不应残留本次创建的目录
        const leftovers = (await readdir(tmpdir())).filter((name) =>
            name.startsWith("napuketto-video-thumb-"),
        );
        expect(leftovers).toEqual([]);
    });
});
