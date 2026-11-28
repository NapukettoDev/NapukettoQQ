import { checkMediaSignal } from "../process.js";
import { MediaError } from "../types.js";

/** SILK 默认采样率（Hz）。 */
export const SILK_SAMPLE_RATE = 24_000;
export const MAX_AUDIO_SECONDS = 600;
export const MAX_AUDIO_INPUT_BYTES: number = 32 * 1024 * 1024;

const SILK_FRAME_MS = 20;
const SILK_HEADER = Buffer.from("#!SILK_V3");
export const ENCODE_SAMPLE_RATES: ReadonlySet<number> = new Set([
    8000, 12000, 16000, 24000, 32000, 44100, 48000,
]);
export const DECODE_SAMPLE_RATES: ReadonlySet<number> = new Set([8000, 12000, 16000, 24000, 48000]);

export function assertSampleRate(rate: number, allowed: ReadonlySet<number>): void {
    if (!allowed.has(rate)) throw new MediaError(`不支持的音频采样率: ${rate}`);
}

export function assertAudioDuration(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > MAX_AUDIO_SECONDS * 1000) {
        throw new MediaError(`音频时长必须大于 0 且不超过 ${MAX_AUDIO_SECONDS}s`);
    }
}

export function silkHeaderLength(bytes: Buffer): number {
    const prefix = bytes[0] === 2 ? 1 : 0;
    return bytes.subarray(prefix, prefix + SILK_HEADER.length).equals(SILK_HEADER)
        ? prefix + SILK_HEADER.length
        : 0;
}

/** SILK 包按长度跳过，不为元数据读取累计输入，也不接受截断的包。 */
export async function silkDuration(
    chunks: AsyncIterable<Buffer> | Iterable<Buffer>,
    headerLength: number,
    signal?: AbortSignal,
): Promise<number> {
    const scan: SilkScan = {
        remaining: headerLength,
        duration: 0,
        ended: false,
        lengthLow: undefined,
    };
    let bytes = 0;
    for await (const chunk of chunks) {
        checkMediaSignal(signal);
        bytes += chunk.length;
        if (bytes > MAX_AUDIO_INPUT_BYTES) throw new MediaError("SILK 文件超出大小限制");
        consumeSilkChunk(scan, chunk);
    }
    if (scan.remaining !== 0 || scan.lengthLow !== undefined) throw new MediaError("SILK 帧不完整");
    assertAudioDuration(scan.duration);
    return scan.duration;
}

interface SilkScan {
    remaining: number;
    duration: number;
    ended: boolean;
    lengthLow: number | undefined;
}

function consumeSilkChunk(scan: SilkScan, chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
        if (scan.ended) throw new MediaError("SILK 结束标记后仍有数据");
        const skipped = Math.min(scan.remaining, chunk.length - offset);
        scan.remaining -= skipped;
        offset += skipped;
        if (offset === chunk.length) break;
        const value = chunk.readUInt8(offset++);
        if (scan.lengthLow === undefined) {
            scan.lengthLow = value;
            continue;
        }
        scan.remaining = scan.lengthLow + value * 256;
        scan.lengthLow = undefined;
        if (scan.remaining === 0xffff) {
            scan.remaining = 0;
            scan.ended = true;
            continue;
        }
        if (scan.remaining > 0x7fff) throw new MediaError("SILK 帧长度无效");
        scan.duration += SILK_FRAME_MS;
        assertAudioDuration(scan.duration);
    }
}
