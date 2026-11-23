import { mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { execa } from "execa";
import {
    checkMediaSignal,
    FFMPEG_WORK_OPTIONS,
    FFPROBE_WORK_OPTIONS,
    LOCAL_MEDIA_INPUT_OPTIONS,
    localMediaPath,
    MAX_VIDEO_PIXELS,
    mediaProcessOptions,
    readMediaPrefix,
    writeFfmpegOutput,
} from "./process.js";
import type { MediaOperationOptions, TranscodeOptions, VideoInfo } from "./types.js";
import { MediaError } from "./types.js";

const MAX_VIDEO_BYTES = 128 * 1024 * 1024;
const MAX_THUMB_BYTES = 16 * 1024 * 1024;
const MAX_SECONDS = 600;
const MAX_EDGE = 4096;
const MAX_PIXEL_FRAMES = 1920 * 1080 * 30 * 300;
const MAX_FPS = 60;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function record(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function positiveNumber(value: unknown): number {
    const number = typeof value === "string" && value !== "" ? Number(value) : value;
    return typeof number === "number" && Number.isFinite(number) && number > 0 ? number : 0;
}

function frameRate(value: unknown): number {
    if (typeof value !== "string") return 0;
    const [numerator, denominator] = value.split("/");
    const divisor = positiveNumber(denominator);
    return divisor === 0 ? 0 : positiveNumber(numerator) / divisor;
}

function assertDimensions(width: number, height: number): void {
    if (
        !Number.isSafeInteger(width) ||
        !Number.isSafeInteger(height) ||
        width < 1 ||
        height < 1 ||
        width > MAX_EDGE ||
        height > MAX_EDGE ||
        width * height > MAX_VIDEO_PIXELS
    ) {
        throw new MediaError("视频尺寸无效或超出像素限制");
    }
}

interface ProbedVideo {
    width: number;
    height: number;
    seconds: number;
    fps: number;
    packets: number;
    codec: unknown;
    format: unknown;
}

function displayDimensions(stream: Record<string, unknown>): [number, number] {
    const width = positiveNumber(stream["width"]);
    const height = positiveNumber(stream["height"]);
    assertDimensions(width, height);
    const sideData = stream["side_data_list"];
    const rotated =
        Array.isArray(sideData) &&
        sideData.some((item) => Math.abs(Number(record(item)?.["rotation"])) % 180 === 90);
    return rotated ? [height, width] : [width, height];
}

function parseVideoProbe(output: string, source: string): ProbedVideo {
    const parsed = record(JSON.parse(output));
    const streams = parsed?.["streams"];
    // V:0 already selects the first real video stream, excluding attached covers.
    const stream = Array.isArray(streams) ? record(streams[0]) : undefined;
    if (stream === undefined) throw new MediaError(`ffprobe 未取到视频信息: ${source}`);
    const [width, height] = displayDimensions(stream);
    const format = record(parsed?.["format"]);
    const seconds = positiveNumber(format?.["duration"]);
    const fps = frameRate(stream["avg_frame_rate"]) || frameRate(stream["r_frame_rate"]);
    if (seconds === 0 || seconds > MAX_SECONDS || fps === 0 || fps > MAX_FPS) {
        throw new MediaError("视频时长或帧率无效或超出限制");
    }
    return {
        width,
        height,
        seconds,
        fps,
        packets: positiveNumber(stream["nb_read_packets"]),
        codec: stream["codec_name"],
        format: format?.["format_name"],
    };
}

async function probeVideo(
    source: string,
    signal?: AbortSignal,
    countPackets = false,
): Promise<ProbedVideo> {
    checkMediaSignal(signal);
    try {
        const result = await execa(
            "ffprobe",
            [
                "-v",
                "error",
                ...FFPROBE_WORK_OPTIONS,
                ...LOCAL_MEDIA_INPUT_OPTIONS,
                "-select_streams",
                "V:0",
                ...(countPackets ? ["-count_packets"] : []),
                "-show_entries",
                "stream=width,height,codec_name,avg_frame_rate,r_frame_rate,nb_read_packets:stream_side_data=rotation:format=duration,format_name",
                "-of",
                "json",
                "-i",
                source,
            ],
            mediaProcessOptions(15_000, signal),
        );
        checkMediaSignal(signal);
        if (result.exitCode !== 0 || result.failed) {
            throw new MediaError(`ffprobe 读取失败: ${source}（exit ${result.exitCode ?? "?"}）`, {
                cause: result,
            });
        }
        return parseVideoProbe(result.stdout, source);
    } catch (error) {
        checkMediaSignal(signal);
        if (error instanceof MediaError) throw error;
        throw new MediaError(`ffprobe 读取失败: ${source}`, { cause: error });
    }
}

function validOutputEdge(edge: number | undefined): boolean {
    return (
        edge === undefined ||
        (Number.isSafeInteger(edge) && edge >= 2 && edge <= MAX_EDGE && edge % 2 === 0)
    );
}

function assertTranscodeOptions(opts: TranscodeOptions): void {
    const { width, height, fps } = opts;
    if (!validOutputEdge(width) || !validOutputEdge(height)) {
        throw new MediaError("转码宽高须为 2–4096 的偶整数");
    }
    if (width !== undefined && height !== undefined) assertDimensions(width, height);
    if (fps !== undefined && (!Number.isFinite(fps) || fps < 1 || fps > MAX_FPS)) {
        throw new MediaError("转码帧率须为 1–60 的有限数");
    }
}

function outputDimensions(source: ProbedVideo, opts: TranscodeOptions): [number, number] {
    const { width, height } = source;
    const w =
        opts.width ??
        (opts.height === undefined
            ? Math.max(2, width - (width % 2))
            : Math.round((opts.height * width) / height / 2) * 2);
    const h =
        opts.height ??
        (opts.width === undefined
            ? Math.max(2, height - (height % 2))
            : Math.round((opts.width * height) / width / 2) * 2);
    assertDimensions(w, h);
    return [w, h];
}

/** 转码到独占目录。成功后调用方拥有输出文件及其父临时目录，消费结束后负责删除。 */
export async function transcodeVideo(input: string, opts: TranscodeOptions = {}): Promise<string> {
    const { signal } = opts;
    checkMediaSignal(signal);
    assertTranscodeOptions(opts);
    const source = await localMediaPath(input, MAX_VIDEO_BYTES);
    const info = await probeVideo(source, signal);
    const [width, height] = outputDimensions(info, opts);
    const maxFrames = Math.floor(MAX_PIXEL_FRAMES / (width * height));
    if (
        info.width * info.height * Math.ceil(info.seconds * info.fps) > MAX_PIXEL_FRAMES ||
        Math.ceil(info.seconds * (opts.fps ?? info.fps)) > maxFrames
    ) {
        throw new MediaError("视频超出转码像素帧预算");
    }
    checkMediaSignal(signal);
    const dir = await mkdtemp(join(dirname(source), ".napuketto-video-"));
    const output = join(dir, "output.mp4");
    const scale = `scale=${width}:${height}`;
    const filter = opts.fps === undefined ? scale : `fps=${opts.fps}:eof_action=pass,${scale}`;
    try {
        await writeFfmpegOutput(
            [
                "-nostdin",
                "-v",
                "error",
                ...FFMPEG_WORK_OPTIONS,
                ...LOCAL_MEDIA_INPUT_OPTIONS,
                "-i",
                source,
                "-map",
                "0:V:0",
                "-map",
                "0:a:0?",
                "-vf",
                filter,
                ...(opts.fps === undefined ? ["-fpsmax", String(MAX_FPS)] : []),
                "-frames:v",
                String(maxFrames + 1),
                "-t",
                String(MAX_SECONDS + 1),
                "-c:v",
                "libx264",
                "-preset",
                "fast",
                "-pix_fmt",
                "yuv420p",
                "-bf",
                "0",
                "-threads:v",
                "2",
                "-maxrate",
                "8M",
                "-bufsize",
                "16M",
                "-c:a",
                "aac",
                "-ac",
                "2",
                "-b:a",
                "128k",
                "-movflags",
                "+empty_moov+default_base_moof+frag_keyframe+negative_cts_offsets",
                "-frag_duration",
                "1000000",
                "-f",
                "mp4",
            ],
            output,
            MAX_VIDEO_BYTES,
            300_000,
            signal,
        );
        const converted = await probeVideo(output, signal, true);
        if (
            converted.width !== width ||
            converted.height !== height ||
            converted.codec !== "h264" ||
            typeof converted.format !== "string" ||
            !converted.format.split(",").includes("mp4") ||
            !Number.isSafeInteger(converted.packets) ||
            converted.packets === 0 ||
            converted.packets > maxFrames
        ) {
            throw new MediaError("转码产物的封装、尺寸、编码或帧数无效");
        }
        if (opts.fps !== undefined && Math.abs(converted.fps - opts.fps) > opts.fps / 1000) {
            throw new MediaError("转码产物帧率与请求不符");
        }
        checkMediaSignal(signal);
        return output;
    } catch (error) {
        await rm(dir, { recursive: true, force: true });
        if (error instanceof MediaError) throw error;
        throw new MediaError(`ffmpeg 不可用或转码失败: ${input}`, { cause: error });
    }
}

/** 读取视频显示尺寸与时长。 */
export async function getVideoInfo(
    input: string,
    { signal }: MediaOperationOptions = {},
): Promise<VideoInfo> {
    checkMediaSignal(signal);
    const { width, height, seconds } = await probeVideo(
        await localMediaPath(input, MAX_VIDEO_BYTES),
        signal,
    );
    return { width, height, durationMs: Math.round(seconds * 1000) };
}

/** 抽首帧至调用者指定路径。失败时保留原目标。 */
export async function extractVideoFrame(
    input: string,
    outputPath: string,
    { signal }: MediaOperationOptions = {},
): Promise<string> {
    checkMediaSignal(signal);
    const source = await localMediaPath(input, MAX_VIDEO_BYTES);
    const requestedTarget = resolve(outputPath);
    const target = join(await realpath(dirname(requestedTarget)), basename(requestedTarget));
    if (
        source === target ||
        (process.platform === "win32" && source.toLowerCase() === target.toLowerCase())
    ) {
        throw new MediaError("抽帧输出不能覆盖输入文件");
    }
    const dir = await mkdtemp(join(dirname(target), ".napuketto-frame-"));
    const output = join(dir, "frame.png");
    try {
        await writeFfmpegOutput(
            [
                "-nostdin",
                "-v",
                "error",
                ...FFMPEG_WORK_OPTIONS,
                "-ss",
                "0",
                ...LOCAL_MEDIA_INPUT_OPTIONS,
                "-i",
                source,
                "-map",
                "0:V:0",
                "-frames:v",
                "1",
                "-c:v",
                "png",
                "-threads:v",
                "2",
                "-f",
                "image2pipe",
            ],
            output,
            MAX_THUMB_BYTES,
            30_000,
            signal,
        );
        const header = await readMediaPrefix(output, 24, signal);
        if (
            header.length !== 24 ||
            !header.subarray(0, 8).equals(PNG_SIGNATURE) ||
            header.toString("latin1", 12, 16) !== "IHDR"
        ) {
            throw new MediaError("抽帧产物不是有效的 PNG");
        }
        assertDimensions(header.readUInt32BE(16), header.readUInt32BE(20));
        checkMediaSignal(signal);
        await rename(output, target);
        return outputPath;
    } catch (error) {
        if (error instanceof MediaError) throw error;
        throw new MediaError(`ffmpeg 不可用或抽帧失败: ${input}`, { cause: error });
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}
