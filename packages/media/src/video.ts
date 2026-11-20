/**
 * 视频（execa 调用外部 ffmpeg 二进制）
 *
 * ffmpeg 由 execa 以子进程方式调用（非 node 内置），依赖系统 PATH 中的 ffmpeg。
 * - `transcodeVideo`：转码 / 缩放 / 帧率
 * - `getVideoInfo`：解析 ffprobe 输出取宽高与时长
 * - `extractVideoFrame`：抽首帧作缩略图（QQ 视频消息发送需要）
 */
import { mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { execa } from "execa";
import {
    assertMediaOutput,
    LOCAL_MEDIA_INPUT_OPTIONS,
    localMediaPath,
    mediaProcessOptions,
} from "./process.js";
import type { TranscodeOptions, VideoInfo } from "./types.js";
import { MediaError } from "./types.js";

const MS_PER_SECOND = 1000;

/** ffprobe JSON 输出的解析形状。 */
interface FfprobeParse {
    streams?: Array<{ width?: number; height?: number; ["codec_type"]?: string }>;
    format?: { duration?: string };
}

/** 判断未知值是否为非 null、非数组的普通对象（media 零内部依赖，就地实现）。 */
function isRecord(val: unknown): val is Record<string, unknown> {
    return typeof val === "object" && val !== null && !Array.isArray(val);
}

/** ffprobe 单个 stream 项安全构造（非对象 / 字段类型不符 → null）。 */
function parseFfprobeStream(
    item: unknown,
): { width?: number; height?: number; ["codec_type"]?: string } | null {
    if (!isRecord(item)) {
        return null;
    }
    const width = item["width"];
    const height = item["height"];
    const codecType = item["codec_type"];
    return {
        ...(typeof width === "number" ? { width } : {}),
        ...(typeof height === "number" ? { height } : {}),
        ...(typeof codecType === "string" ? { ["codec_type"]: codecType } : {}),
    };
}

/** ffprobe format 段安全构造（缺失 / duration 非字符串 → undefined）。 */
function parseFfprobeFormat(raw: unknown): { duration?: string } | undefined {
    if (!isRecord(raw)) {
        return undefined;
    }
    const duration = raw["duration"];
    return typeof duration === "string" ? { duration } : undefined;
}

/** ffprobe JSON → 安全构造的形状（非对象 / 字段类型不符 → null）。 */
function parseFfprobe(raw: unknown): FfprobeParse | null {
    if (!isRecord(raw)) {
        return null;
    }
    const streams: NonNullable<FfprobeParse["streams"]> = [];
    const streamsRaw = raw["streams"];
    if (Array.isArray(streamsRaw)) {
        for (const item of streamsRaw) {
            const stream = parseFfprobeStream(item);
            if (stream !== null) {
                streams.push(stream);
            }
        }
    }
    const format = parseFfprobeFormat(raw["format"]);
    return {
        ...(streams.length > 0 ? { streams } : {}),
        ...(format !== undefined ? { format } : {}),
    };
}

/** 转码到独占目录。成功后调用方拥有输出文件及其父临时目录，消费结束后负责删除。 */
export async function transcodeVideo(input: string, opts: TranscodeOptions = {}): Promise<string> {
    const source = await localMediaPath(input);
    const args = ["-nostdin", "-v", "error", "-y", ...LOCAL_MEDIA_INPUT_OPTIONS, "-i", source];
    if (opts.width !== undefined && opts.height !== undefined) {
        args.push("-vf", `scale=${opts.width}:${opts.height}`);
    } else if (opts.width !== undefined) {
        args.push("-vf", `scale=${opts.width}:-2`);
    } else if (opts.height !== undefined) {
        args.push("-vf", `scale=-2:${opts.height}`);
    }
    if (opts.fps !== undefined) {
        args.push("-r", String(opts.fps));
    }
    const dir = await mkdtemp(join(dirname(source), ".napuketto-video-"));
    const output = join(dir, "output.mp4");
    args.push("-c:v", "libx264", "-preset", "fast", output);

    try {
        const result = await execa("ffmpeg", args, mediaProcessOptions(300_000));
        if (result.exitCode !== 0 || result.failed) {
            throw new MediaError(`ffmpeg 转码失败: ${input}（exit ${result.exitCode ?? "?"}）`, {
                cause: result,
            });
        }
        await assertMediaOutput(output);
        return output;
    } catch (err) {
        await rm(dir, { recursive: true, force: true });
        if (err instanceof MediaError) {
            throw err;
        }
        throw new MediaError(`ffmpeg 不可用或转码失败: ${input}`, { cause: err });
    }
}

/** 读取视频宽高与时长（ffprobe JSON 输出解析）。 */
export async function getVideoInfo(input: string): Promise<VideoInfo> {
    const source = await localMediaPath(input);
    let parsed: FfprobeParse;
    try {
        const result = await execa(
            "ffprobe",
            [
                "-v",
                "error",
                ...LOCAL_MEDIA_INPUT_OPTIONS,
                "-print_format",
                "json",
                "-show_format",
                "-show_streams",
                "-i",
                source,
            ],
            mediaProcessOptions(15_000),
        );
        if (result.exitCode !== 0 || result.failed) {
            throw new MediaError(`ffprobe 读取失败: ${input}（exit ${result.exitCode}）`, {
                cause: result,
            });
        }
        const parsedJson: unknown = JSON.parse(result.stdout);
        const info = parseFfprobe(parsedJson);
        if (info === null) {
            throw new MediaError(`ffprobe 输出格式无效: ${input}`);
        }
        parsed = info;
    } catch (err) {
        if (err instanceof MediaError) {
            throw err;
        }
        throw new MediaError(`ffprobe 读取失败: ${input}`, { cause: err });
    }

    const videoStream = parsed.streams?.find((s) => s["codec_type"] === "video");
    const width = videoStream?.width;
    const height = videoStream?.height;
    const durationStr = parsed.format?.duration;
    if (width === undefined || height === undefined || durationStr === undefined) {
        throw new MediaError(`ffprobe 未取到视频信息: ${input}`);
    }
    return { width, height, durationMs: Math.round(Number(durationStr) * MS_PER_SECOND) };
}

/**
 * 抽视频首帧为 PNG 缩略图（QQ 视频消息发送契约：thumbPath 指向真实图片文件）。
 *
 * 固定 `-ss 0` 取首帧：QQ 缩略图只需要一张可解码的封面，首帧最稳定
 * （部分视频首帧为黑屏时可改 1s，此处不引入额外配置）。转码失败 / ffmpeg
 * 缺失 / 输出未生成均抛 MediaError，由调用方决定降级策略。
 */
export async function extractVideoFrame(input: string, outputPath: string): Promise<string> {
    const source = await localMediaPath(input);
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
    const args = [
        "-nostdin",
        "-v",
        "error",
        "-y",
        "-ss",
        "0",
        ...LOCAL_MEDIA_INPUT_OPTIONS,
        "-i",
        source,
        "-frames:v",
        "1",
        "-q:v",
        "3",
        "-f",
        "image2",
        output,
    ];
    try {
        const result = await execa("ffmpeg", args, mediaProcessOptions(30_000));
        if (result.exitCode !== 0 || result.failed) {
            throw new MediaError(`ffmpeg 抽帧失败: ${input}（exit ${result.exitCode ?? "?"}）`, {
                cause: result,
            });
        }
        await assertMediaOutput(output);
        await rename(output, target);
        return outputPath;
    } catch (err) {
        if (err instanceof MediaError) {
            throw err;
        }
        throw new MediaError(`ffmpeg 不可用或抽帧失败: ${input}`, { cause: err });
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}
