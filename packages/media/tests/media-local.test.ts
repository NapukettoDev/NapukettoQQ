import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execa } from "execa";
import { isSilk } from "silk-wasm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodePcmToSilk } from "../src/audio.js";
import { mediaProcessOptions } from "../src/process.js";
import { MediaError } from "../src/types.js";
import { extractVideoFrame, getVideoInfo, transcodeVideo } from "../src/video.js";

const available = ["ffmpeg", "ffprobe"].every(
    (command) =>
        spawnSync(command, ["-version"], { timeout: 3000, stdio: "ignore", windowsHide: true })
            .status === 0,
);

describe.skipIf(!available)("H-02: 真实本地 FFmpeg 契约", () => {
    let dir: string;
    beforeEach(() => {
        dir = realpathSync.native(mkdtempSync(join(tmpdir(), "nk-local-media-")));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("MP4 同路径转码、探测、PNG 抽帧与立体声音频归一化", async () => {
        const input = join(dir, "-视频 空格.mp4");
        await execa(
            "ffmpeg",
            [
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=c=red:s=32x32:d=0.2",
                "-c:v",
                "libx264",
                input,
            ],
            { ...mediaProcessOptions(10_000), reject: true },
        );
        const original = readFileSync(input);
        const output = await transcodeVideo(input);
        expect(output).not.toBe(input);
        expect(readFileSync(input)).toEqual(original);
        expect(await getVideoInfo(output)).toMatchObject({ width: 32, height: 32 });
        const png = join(dir, "-封面.png");
        await extractVideoFrame(output, png);
        expect(readFileSync(png).subarray(0, 8)).toEqual(
            Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        );
        const audio = join(dir, "-立体声.wav");
        await execa(
            "ffmpeg",
            [
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=0.1",
                "-ac",
                "2",
                audio,
            ],
            { ...mediaProcessOptions(10_000), reject: true },
        );
        expect(isSilk(readFileSync(await encodePcmToSilk(audio)))).toBe(true);
        rmSync(dirname(output), { recursive: true });
    });

    it("伪装为 mp4 的 HLS/concat 不能触发本地 HTTP 访问", async () => {
        let requests = 0;
        const server = createServer((_request, response) => {
            requests++;
            response.end("unexpected");
        });
        await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
        try {
            const address = server.address();
            if (address === null || typeof address === "string") throw new Error("missing port");
            const url = `http://127.0.0.1:${address.port}/segment.ts`;
            const input = join(dir, "playlist.mp4");
            for (const content of [
                `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n${url}\n#EXT-X-ENDLIST\n`,
                `ffconcat version 1.0\nfile '${url}'\n`,
            ]) {
                writeFileSync(input, content);
                await expect(getVideoInfo(input)).rejects.toThrow(MediaError);
                await expect(transcodeVideo(input)).rejects.toThrow(MediaError);
                await expect(extractVideoFrame(input, join(dir, "thumb.png"))).rejects.toThrow(
                    MediaError,
                );
                await expect(encodePcmToSilk(input)).rejects.toThrow(MediaError);
            }
            expect(requests).toBe(0);
        } finally {
            await new Promise<void>((done, fail) =>
                server.close((error) => (error === undefined ? done() : fail(error))),
            );
        }
    });

    it("小体积 FLAC 解码超过 600s 时拒绝，不能静默截断发送", async () => {
        const input = join(dir, "long.flac");
        await execa(
            "ffmpeg",
            [
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "anullsrc=r=8000:cl=mono",
                "-t",
                "601",
                "-c:a",
                "flac",
                input,
            ],
            { ...mediaProcessOptions(10_000), reject: true },
        );
        expect(readFileSync(input).byteLength).toBeLessThan(1024 * 1024);
        await expect(encodePcmToSilk(input)).rejects.toThrow(MediaError);
    });
});
