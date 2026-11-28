import type { Context } from "hono";
import type { HttpServerOptions, Respond } from "../types.js";

const HTTP_STATUS = {
    internalError: 500,
    unavailable: 503,
    timeout: 504,
} as const;

export function dispatchJsonRequest(
    c: Context,
    pending: Set<() => void>,
    options: Pick<HttpServerOptions, "timeoutMs">,
    isClosing: () => boolean,
    dispatch: (respond: Respond) => void,
): Promise<Response> {
    return new Promise<Response>((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const signal = c.req.raw.signal;
        const finish = (response: Response): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
            pending.delete(onClose);
            resolve(response);
        };
        // 客户端已断开，仅结算等待与清理；该状态不会再发送到客户端。
        const onAbort = (): void => finish(new Response(null, { status: 499 }));
        const onClose = (): void =>
            finish(c.json({ error: "server shutdown" }, HTTP_STATUS.unavailable));
        const respond: Respond = (res, status = 200) => {
            if (settled) return;
            try {
                finish(
                    new Response(res === undefined ? null : JSON.stringify(res), {
                        status,
                        ...(res === undefined
                            ? {}
                            : { headers: { "Content-Type": "application/json" } }),
                    }),
                );
            } catch {
                finish(c.json({ error: "internal server error" }, HTTP_STATUS.internalError));
            }
        };
        pending.add(onClose);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) {
            onAbort();
            return;
        }
        if (isClosing()) {
            onClose();
            return;
        }
        if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
            timer = setTimeout(() => {
                finish(c.json({ error: "request timeout" }, HTTP_STATUS.timeout));
            }, options.timeoutMs);
            timer.unref();
        }
        try {
            dispatch(respond);
        } catch {
            respond({ error: "internal server error" }, HTTP_STATUS.internalError);
        }
    });
}
