import type { Server } from "node:http";
import type { Socket } from "node:net";
import type { WebSocketServer } from "ws";

const CLOSE_GRACE_MS = 250;

/** HTTP server.close 不等待已升级的 TCP 连接，必须单独等待它们释放。 */
export async function closeServerConnections(
    server: Server,
    sockets: ReadonlySet<Socket>,
    wss: WebSocketServer | undefined,
): Promise<void> {
    const httpClosed = new Promise<void>((resolve) => server.close(() => resolve()));
    const socketsClosed = Array.from(
        sockets,
        (socket) => new Promise<void>((resolve) => socket.once("close", () => resolve())),
    );
    const wsClosed = wss && new Promise<void>((resolve) => wss.close(() => resolve()));
    if (wss) for (const client of wss.clients) client.close(1001, "server shutdown");

    const timer = setTimeout(() => {
        if (wss) for (const client of wss.clients) client.terminate();
        for (const socket of sockets) socket.destroy();
    }, CLOSE_GRACE_MS).unref();
    try {
        await Promise.all([httpClosed, wsClosed, ...socketsClosed]);
    } finally {
        clearTimeout(timer);
    }
}
