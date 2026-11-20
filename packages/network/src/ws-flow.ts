import { randomBytes } from "node:crypto";
import { isWsOpen, type WsHeartbeatOptions, type WsSocket } from "./types.js";

const DEFAULT_MAX_BUFFERED_BYTES = 32 * 1024 * 1024;
// 基础头 2 + 扩展长度 8 + 客户端掩码 4。
const MAX_FRAME_HEADER_BYTES = 14;

/** 向选定连接发送文本，超出发送预算时立即断开对应连接。 */
export function sendWsText(
    sockets: Iterable<WsSocket>,
    data: string | undefined,
    maxBufferedBytes = DEFAULT_MAX_BUFFERED_BYTES,
): void {
    const limit =
        Number.isSafeInteger(maxBufferedBytes) && maxBufferedBytes > 0
            ? maxBufferedBytes
            : DEFAULT_MAX_BUFFERED_BYTES;
    const text = data ?? "";
    const frameBytes = Buffer.byteLength(text) + MAX_FRAME_HEADER_BYTES;
    for (const socket of sockets) {
        if (!isWsOpen(socket)) continue;
        if (socket.bufferedAmount + frameBytes > limit) {
            socket.terminate();
            continue;
        }
        socket.send(text);
    }
}

/** 串行探测，每条连接最多等待一个 pong。返回幂等的停止函数。 */
export function startWsHeartbeat(socket: WsSocket, opts: WsHeartbeatOptions): () => void {
    const pongTimeoutMs = opts.pongTimeoutMs ?? Math.max(opts.intervalMs, 1_000);
    let expectedPong: Buffer | undefined;
    let timer = setTimeout(ping, opts.intervalMs).unref();
    socket.on("pong", onPong);
    socket.once("close", stop);

    function ping(): void {
        if (!isWsOpen(socket)) {
            stop();
            return;
        }
        expectedPong = randomBytes(8);
        timer = setTimeout(() => {
            stop();
            if (isWsOpen(socket)) socket.terminate();
        }, pongTimeoutMs).unref();
        socket.ping(expectedPong);
    }

    function onPong(pong: Buffer): void {
        if (!expectedPong?.equals(pong)) return;
        expectedPong = undefined;
        clearTimeout(timer);
        timer = setTimeout(ping, opts.intervalMs).unref();
    }

    function stop(): void {
        clearTimeout(timer);
        socket.off("pong", onPong);
        socket.off("close", stop);
    }

    return stop;
}
