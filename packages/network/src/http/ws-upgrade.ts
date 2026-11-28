import { type Server, STATUS_CODES } from "node:http";
import type { Duplex } from "node:stream";
import { types } from "node:util";
import type { WebSocketServer } from "ws";
import {
    incomingMessageToRequestContext,
    type RequestContext,
    type WsSocket,
    type WsUpgradeHook,
} from "../types.js";

const HTTP_STATUS = {
    notFound: 404,
    internalError: 500,
    unavailable: 503,
} as const;

const STATUS_REASON = /^[ -~]{1,128}$/;

type UpgradeDecision =
    | { accept: (socket: WsSocket) => void }
    | { status: number; reason?: string | undefined };

function decideUpgrade(hook: WsUpgradeHook | undefined, req: RequestContext): UpgradeDecision {
    let decision: UpgradeDecision | undefined;
    try {
        const result: unknown = hook?.(
            req,
            (accept) => {
                decision ??= { accept };
            },
            (status, reason) => {
                decision ??= { status, reason };
            },
        );
        if (types.isPromise(result)) {
            result.catch(() => undefined);
            return { status: HTTP_STATUS.internalError };
        }
        return decision ?? { status: HTTP_STATUS.notFound };
    } catch {
        return { status: HTTP_STATUS.internalError };
    }
}

function rejectUpgrade(socket: Duplex, status: number, reason?: string): void {
    if (socket.destroyed || !socket.writable) {
        socket.destroy();
        return;
    }
    if (!Number.isInteger(status) || status < 400 || status > 599) {
        status = HTTP_STATUS.internalError;
        reason = undefined;
    }
    const text =
        reason !== undefined && STATUS_REASON.test(reason) ? reason : (STATUS_CODES[status] ?? "");
    socket.once("error", () => socket.destroy());
    socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () =>
        socket.destroy(),
    );
}

/** Hono 不接管 upgrade；握手交由同一端口上的 noServer WSS。 */
export function attachWsUpgrade(
    server: Server,
    wss: WebSocketServer,
    getHook: () => WsUpgradeHook | undefined,
    isClosing: () => boolean,
): void {
    server.on("upgrade", (req, socket: Duplex, head: Buffer) => {
        const decision = decideUpgrade(getHook(), incomingMessageToRequestContext(req));
        if (isClosing()) {
            rejectUpgrade(socket, HTTP_STATUS.unavailable);
            return;
        }
        if ("status" in decision) {
            rejectUpgrade(socket, decision.status, decision.reason);
            return;
        }
        try {
            wss.handleUpgrade(req, socket, head, (client) => {
                try {
                    const result: unknown = decision.accept(client);
                    if (types.isPromise(result)) {
                        result.catch(() => client.terminate());
                    }
                } catch {
                    client.terminate();
                }
            });
        } catch {
            // ws 已接手握手与 socket 监听器，握手内部异常交给 socket 回收。
            socket.destroy();
        }
    });
}
