import { open, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { Options } from "execa";
import { MediaError } from "./types.js";

const WINDOWS_DRIVE = /^[a-z]:[\\/]/i;
const NETWORK_OR_DEVICE_PATH = /^[\\/]{2}/;
const PROTOCOL_PREFIX = /^[a-z][a-z\d+.-]*:/i;

/** Input options must precede -i (also applied by ffprobe to nested inputs). */
export const LOCAL_MEDIA_INPUT_OPTIONS = [
    "-protocol_whitelist",
    "file",
    "-format_whitelist",
    "mov,matroska,webm,avi,flv,asf,mpeg,mpegts,ogg,wav,mp3,flac,aac,amr,aiff,ape,ac3,eac3,dts,au",
];

export function mediaProcessOptions(timeout: number) {
    return {
        reject: false,
        timeout,
        killSignal: "SIGTERM",
        forceKillAfterDelay: 1000,
        cleanup: true,
        stdin: "ignore",
        windowsHide: true,
        maxBuffer: 1024 * 1024,
    } satisfies Options;
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
export async function localMediaPath(input: string): Promise<string> {
    assertLocalPath(input);
    try {
        const path = await realpath(resolve(input));
        assertLocalPath(path);
        if (!(await stat(path)).isFile()) {
            throw new MediaError(`媒体输入必须是本地普通文件: ${input}`);
        }
        return path;
    } catch (error) {
        if (error instanceof MediaError) {
            throw error;
        }
        throw new MediaError(`无法读取本地媒体: ${input}`, { cause: error });
    }
}

export async function assertMediaOutput(
    path: string,
    maxBytes = Number.MAX_SAFE_INTEGER,
): Promise<void> {
    const info = await stat(path);
    if (!info.isFile() || info.size === 0 || info.size > maxBytes) {
        throw new MediaError(`媒体输出缺失、为空或超出大小限制: ${path}`);
    }
}

/** Bound allocation and reads even if a caller changes the input after stat. */
export async function readBoundedMediaFile(path: string, maxBytes: number): Promise<Buffer> {
    const handle = await open(path, "r");
    try {
        const info = await handle.stat();
        if (!info.isFile() || info.size === 0 || info.size > maxBytes) {
            throw new MediaError(`媒体文件为空或超出大小限制: ${path}`);
        }
        const buffer = Buffer.alloc(info.size + 1);
        let offset = 0;
        while (offset < buffer.byteLength) {
            const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset);
            if (bytesRead === 0) {
                return buffer.subarray(0, offset);
            }
            offset += bytesRead;
        }
        throw new MediaError(`读取期间媒体文件大小发生变化: ${path}`);
    } finally {
        await handle.close();
    }
}
