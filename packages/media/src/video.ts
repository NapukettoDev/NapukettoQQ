/**
 * 视频（execa 调用外部 ffmpeg 二进制）
 *
 * ffmpeg 由 execa 以子进程方式调用（非 node 内置），依赖系统 PATH 中的 ffmpeg。
 * - `transcodeVideo`：转码 / 缩放 / 帧率
 * - `getVideoInfo`：解析 ffprobe 输出取宽高与时长
 * - `extractVideoFrame`：抽首帧作缩略图（QQ 视频消息发送需要）
 */
import { existsSync } from "node:fs";
import { execa } from "execa";
import type { TranscodeOptions, VideoInfo } from "./types.js";
import { MediaError } from "./types.js";

const MS_PER_SECOND = 1000;

/** ffprobe JSON 输出的解析形状。 */
interface FfprobeParse {
    streams?: Array<{ width?: number; height?: number; ["codec_type"]?: string }>;
    format?: { duration?: string };
}

/** 替换扩展名（保持目录，父目录由调用方保证存在）。 */
function replaceExt(input: string, ext: string): string {
    const slash = input.lastIndexOf("/");
    const backslash = input.lastIndexOf("\\");
    const dirEnd = Math.max(slash, backslash);
    let dir: string;
    let base: string;
    if (dirEnd >= 0) {
        dir = input.slice(0, dirEnd + 1);
        base = input.slice(dirEnd + 1);
    } else {
        dir = "";
        base = input;
    }
    const dot = base.lastIndexOf(".");
    let stem: string;
    if (dot > 0) {
        stem = base.slice(0, dot);
    } else {
        stem = base;
    }
    return `${dir}${stem}${ext}`;
}

/** 转码：按选项输出到替换扩展名后的路径（.mp4）。ffmpeg 缺失/失败抛 MediaError。 */
export async function transcodeVideo(input: string, opts: TranscodeOptions = {}): Promise<string> {
    const args = ["-y", "-i", input];
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
    const output = replaceExt(input, ".mp4");
    args.push("-c:v", "libx264", "-preset", "fast", output);

    let exitCode: number | undefined;
    try {
        const result = await execa("ffmpeg", args, { reject: false });
        exitCode = result.exitCode;
    } catch (err) {
        throw new MediaError(`ffmpeg 不可用或转码失败: ${input}`, { cause: err });
    }
    // exitCode 校验（2026-09-08 T6 加固）：reject:false 不抛非零退出，此前
    // 失败也返回 output 路径（文件不存在）——调用方拿到幽灵路径
    if (exitCode !== 0 || !existsSync(output)) {
        throw new MediaError(`ffmpeg 转码失败: ${input}（exit ${exitCode ?? "?"}）`);
    }
    return output;
}

/** 读取视频宽高与时长（ffprobe JSON 输出解析）。 */
export async function getVideoInfo(input: string): Promise<VideoInfo> {
    let parsed: FfprobeParse;
    try {
        const result = await execa(
            "ffprobe",
            ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", input],
            { reject: false },
        );
        if (result.exitCode !== 0) {
            throw new MediaError(`ffprobe 读取失败: ${input}（exit ${result.exitCode}）`);
        }
        parsed = JSON.parse(result.stdout) as FfprobeParse;
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
    const args = [
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
        outputPath,
    ];
    let exitCode: number | undefined;
    try {
        const result = await execa("ffmpeg", args, { reject: false });
        exitCode = result.exitCode;
    } catch (err) {
        throw new MediaError(`ffmpeg 不可用或抽帧失败: ${input}`, { cause: err });
    }
    if (exitCode !== 0 || !existsSync(outputPath)) {
        throw new MediaError(`ffmpeg 抽帧失败: ${input}（exit ${exitCode ?? "?"}）`);
    }
    return outputPath;
}
