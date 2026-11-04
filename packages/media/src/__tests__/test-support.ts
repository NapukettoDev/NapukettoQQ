/**
 * media 测试公共辅助（audio / video / image / downloader 用例共享）
 *
 * - PCM / WAV 夹具按字节规范内联构造（不提交二进制文件）；
 * - 临时目录统一 mkdtemp 前缀 + afterEach 清理；
 * - 下载器用例的本地 HTTP 桩收敛到 127.0.0.1 临时端口（node:http 真实端口）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 生成正弦波 pcm_s16le（避免全零被编码器特殊处理）。 */
export function makePcm(seconds: number, rate: number): Buffer {
    const n = seconds * rate;
    const buf = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) {
        buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), i * 2);
    }
    return buf;
}

/** WAV 夹具规格（44 字节 RIFF 头按参数拼装）。 */
export interface WavSpec {
    /** 采样率。 */
    rate: number;
    /** 声道数（1 = 单声道，2 = 立体声）。 */
    channels: number;
    /** 位深（缺省 16）。 */
    bits?: number;
    /** fmt formatCode（缺省 1 = PCM；3 = IEEE float）。 */
    formatCode?: number;
}

/** 按规格构造 WAV 字节（RIFF 头 + PCM 数据，数据部分由调用方传入）。 */
export function makeWav(spec: WavSpec, pcm: Buffer): Buffer {
    const bits = spec.bits ?? 16;
    const formatCode = spec.formatCode ?? 1;
    const bytesPerSample = bits / 8;
    const blockAlign = spec.channels * bytesPerSample;
    const header = Buffer.alloc(44);
    header.write("RIFF", 0, "ascii");
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write("WAVE", 8, "ascii");
    header.write("fmt ", 12, "ascii");
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(formatCode, 20);
    header.writeUInt16LE(spec.channels, 22);
    header.writeUInt32LE(spec.rate, 24);
    header.writeUInt32LE(spec.rate * blockAlign, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bits, 34);
    header.write("data", 36, "ascii");
    header.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([header, pcm]);
}

/** 建测试用临时目录（统一前缀，便于事后排查残留）。 */
export function makeTempDir(prefix: string): string {
    return mkdtempSync(join(tmpdir(), prefix));
}

/** 清理临时目录（force 容忍已不存在）。 */
export function cleanupTempDir(dir: string): void {
    rmSync(dir, { recursive: true, force: true });
}

/** 本地 HTTP 桩句柄（downloader 用例）。 */
export interface HttpStub {
    port: number;
    url: string;
    close: () => Promise<void>;
}

/**
 * 起一个 127.0.0.1 临时 HTTP 桩（node:http）。
 * handler 抛错时按 500 兜底，避免未处理异常击穿测试进程。
 */
export function listenHttp(
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<HttpStub> {
    return new Promise((resolve, reject) => {
        const server: Server = createServer((req, res) => {
            res.on("error", () => undefined);
            Promise.resolve()
                .then(() => handler(req, res))
                .catch(() => {
                    if (!res.headersSent) {
                        res.statusCode = 500;
                    }
                    res.end();
                });
        });
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address();
            if (addr === null || typeof addr === "string") {
                reject(new Error("未取得临时端口"));
                return;
            }
            resolve({
                port: addr.port,
                url: `http://127.0.0.1:${addr.port}`,
                close: () =>
                    new Promise<void>((done) => {
                        server.closeAllConnections();
                        server.close(() => done());
                    }),
            });
        });
    });
}
