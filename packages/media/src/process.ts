import { randomUUID } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { mkdir, open, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execa, type Options } from "execa";
import { MediaError } from "./types.js";

const WINDOWS_DRIVE = /^[a-z]:[\\/]/i;
const NETWORK_OR_DEVICE_PATH = /^[\\/]{2}/;
const PROTOCOL_PREFIX = /^[a-z][a-z\d+.-]*:/i;
export const MAX_VIDEO_PIXELS = 3840 * 2160;
const MAX_FFMPEG_ALLOCATION = String(128 * 1024 * 1024);

/** Input options must precede -i (also applied by ffprobe to nested inputs). */
export const LOCAL_MEDIA_INPUT_OPTIONS: string[] = [
    "-protocol_whitelist",
    "file",
    "-format_whitelist",
    "mov,matroska,webm,avi,flv,asf,mpeg,mpegts,ogg,wav,mp3,flac,aac,amr,aiff,ape,ac3,eac3,dts,au",
    "-max_streams",
    "16",
    "-max_pixels",
    String(MAX_VIDEO_PIXELS),
    "-threads",
    "2",
];

export const FFPROBE_WORK_OPTIONS: readonly string[] = ["-max_alloc", MAX_FFMPEG_ALLOCATION];
export const FFMPEG_WORK_OPTIONS: readonly string[] = [
    ...FFPROBE_WORK_OPTIONS,
    "-filter_threads",
    "1",
    "-xerror",
];

export function mediaProcessOptions(timeout: number, cancelSignal?: AbortSignal) {
    return {
        ...(cancelSignal === undefined ? {} : { cancelSignal }),
        reject: false,
        timeout,
        killSignal: "SIGTERM",
        forceKillAfterDelay: 1000,
        cleanup: true,
        stdin: "ignore",
        windowsHide: true,
        maxBuffer: 1024 * 1024,
    } as const satisfies Options;
}

export function checkMediaSignal(signal?: AbortSignal): void {
    if (signal?.aborted) throw new MediaError("媒体操作已取消", { cause: signal.reason });
}

function assertLocalPath(input: string): void {
    const windowsDrive = process.platform === "win32" && WINDOWS_DRIVE.test(input);
    if (
        input.length === 0 ||
        input.includes("\0") ||
        NETWORK_OR_DEVICE_PATH.test(input) ||
        (PROTOCOL_PREFIX.test(input) && !windowsDrive)
    ) {
        throw new MediaError(`媒体输入必须是本地普通文件: ${input}`);
    }
}

/** Absolute paths protect option-like filenames; realpath also checks symlink targets. No root sandbox. */
export async function localMediaPath(
    input: string,
    maxBytes = Number.MAX_SAFE_INTEGER,
): Promise<string> {
    assertLocalPath(input);
    try {
        const path = await realpath(resolve(input));
        assertLocalPath(path);
        const info = await stat(path);
        if (!info.isFile()) {
            throw new MediaError(`媒体输入必须是本地普通文件: ${input}`);
        }
        if (info.size === 0 || info.size > maxBytes) {
            throw new MediaError(`媒体输入为空或超出大小限制: ${input}`);
        }
        return path;
    } catch (error) {
        if (error instanceof MediaError) {
            throw error;
        }
        throw new MediaError(`无法读取本地媒体: ${input}`, { cause: error });
    }
}

async function assertMediaOutput(path: string, maxBytes: number): Promise<void> {
    const info = await stat(path);
    if (!info.isFile() || info.size === 0 || info.size > maxBytes) {
        throw new MediaError(`媒体输出缺失、为空或超出大小限制: ${path}`);
    }
}

export async function openMediaInput(path: string) {
    return await open(
        path,
        constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK),
    );
}

/** Bound allocation and reads even if a caller changes the input after stat. */
export async function readBoundedMediaFile(
    path: string,
    maxBytes: number,
    signal?: AbortSignal,
): Promise<Buffer> {
    return await readMediaBytes(path, maxBytes, "file", signal);
}

export async function readMediaPrefix(
    path: string,
    maxBytes: number,
    signal?: AbortSignal,
): Promise<Buffer> {
    return await readMediaBytes(path, maxBytes, "prefix", signal);
}

async function readMediaBytes(
    path: string,
    maxBytes: number,
    mode: "file" | "prefix",
    signal?: AbortSignal,
): Promise<Buffer> {
    checkMediaSignal(signal);
    const handle = await openMediaInput(path);
    try {
        const info = await handle.stat();
        if (!info.isFile() || info.size === 0 || (mode === "file" && info.size > maxBytes)) {
            throw new MediaError(`媒体文件为空或超出大小限制: ${path}`);
        }
        // The full read has a sentinel byte to detect growth after opening.
        const buffer = Buffer.alloc(
            mode === "file" ? info.size + 1 : Math.min(maxBytes, info.size),
        );
        let offset = 0;
        while (offset < buffer.length) {
            const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset);
            checkMediaSignal(signal);
            if (bytesRead === 0) break;
            offset += bytesRead;
        }
        if (mode === "file" && offset !== info.size) {
            throw new MediaError(`读取期间媒体文件大小发生变化: ${path}`);
        }
        return buffer.subarray(0, offset);
    } finally {
        await handle.close();
    }
}

/** Enforce the byte limit before writing each chunk, and join the child before allowing cleanup. */
export async function writeFfmpegOutput(
    args: string[],
    path: string,
    maxBytes: number,
    timeout: number,
    signal?: AbortSignal,
): Promise<void> {
    checkMediaSignal(signal);
    const stop = new AbortController();
    const cancel = signal === undefined ? stop.signal : AbortSignal.any([signal, stop.signal]);
    const child = execa("ffmpeg", [...args, "pipe:1"], {
        ...mediaProcessOptions(timeout, cancel),
        buffer: { stdout: false },
    });
    let bytes = 0;
    const limit = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
            bytes += chunk.length;
            if (bytes > maxBytes) {
                callback(new MediaError(`媒体输出超过 ${maxBytes} 字节限制`));
            } else {
                callback(null, chunk);
            }
        },
    });
    const writing = Promise.resolve()
        .then(() => {
            if (child.stdout == null) throw new MediaError("无法读取 FFmpeg 输出管道");
            return pipeline(
                child.stdout,
                limit,
                createWriteStream(path, { flags: "wx", mode: 0o600 }),
            );
        })
        .catch((error: unknown) => {
            stop.abort();
            throw error;
        });
    const [output, processResult] = await Promise.allSettled([writing, child]);
    checkMediaSignal(signal);
    if (output.status === "rejected" && limit.errored instanceof MediaError) throw limit.errored;
    if (processResult.status === "rejected") throw processResult.reason;
    const result = processResult.value;
    if (result.exitCode !== 0 || result.failed) {
        throw new MediaError(`ffmpeg 执行失败（exit ${result.exitCode ?? "?"}）`, {
            cause: result,
        });
    }
    if (output.status === "rejected") throw output.reason;
    await assertMediaOutput(path, maxBytes);
}

export async function publishMediaFile(
    path: string,
    chunks: readonly Uint8Array[],
    signal?: AbortSignal,
): Promise<void> {
    checkMediaSignal(signal);
    await mkdir(dirname(path), { recursive: true });
    const partial = `${path}.part-${process.pid}-${randomUUID()}`;
    const handle = await open(partial, "wx", 0o600);
    try {
        try {
            for (const chunk of chunks) {
                checkMediaSignal(signal);
                await handle.writeFile(chunk, signal === undefined ? undefined : { signal });
            }
        } finally {
            await handle.close();
        }
        checkMediaSignal(signal);
        await rename(partial, path);
    } finally {
        await rm(partial, { force: true });
    }
}
