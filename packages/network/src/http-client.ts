import type { HttpClientOptions, TransportAdapter } from "./types.js";

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_QUEUED_DELIVERIES = 64;
const MAX_PENDING_BYTES = 32 * 1024 * 1024;

interface HttpDelivery {
    body: string | undefined;
    bytes: number;
    deadline: number;
}

export class HttpClient implements TransportAdapter {
    private readonly opts: HttpClientOptions;
    private readonly timeoutMs: number;
    private readonly queue: HttpDelivery[] = [];
    private pendingBytes = 0;
    private shutdown = new AbortController();
    private active: Promise<void> | undefined;

    constructor(opts: HttpClientOptions) {
        this.opts = opts;
        const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.timeoutMs =
            Number.isInteger(timeout) && timeout > 0 && timeout <= MAX_TIMER_DELAY_MS
                ? timeout
                : DEFAULT_TIMEOUT_MS;
    }

    send<T>(payload: T): void {
        const deadline = performance.now() + this.timeoutMs;
        const { signal } = this.shutdown;
        if (signal.aborted) {
            this.reportError(new Error("HTTP 上报已关闭"));
            return;
        }
        let body: string | undefined;
        try {
            body = JSON.stringify(payload);
        } catch (err) {
            this.reportError(err);
            return;
        }
        if (signal.aborted) {
            this.reportError(new Error("HTTP 上报已关闭"));
            return;
        }
        if (this.queue.length >= MAX_QUEUED_DELIVERIES) {
            this.reportError(new Error("HTTP 上报队列已满"));
            return;
        }
        const bytes = body === undefined ? 0 : Buffer.byteLength(body);
        if (this.pendingBytes + bytes > MAX_PENDING_BYTES) {
            this.reportError(new Error("HTTP 上报待发送正文超限"));
            return;
        }
        this.queue.push({ body, bytes, deadline });
        this.pendingBytes += bytes;
        this.active ??= this.drain(signal);
    }

    open(): void | Promise<void> {
        if (!this.shutdown.signal.aborted) return;
        if (this.active) return this.active.then(() => this.open());
        this.shutdown = new AbortController();
    }

    close(): void | Promise<void> {
        this.shutdown.abort();
        this.queue.length = 0;
        this.pendingBytes = 0;
        return this.active;
    }

    private async drain(signal: AbortSignal): Promise<void> {
        try {
            let delivery = this.queue.shift();
            while (delivery !== undefined) {
                const failure = await this.post(delivery, signal).catch((err: unknown) => ({
                    err,
                }));
                if (signal.aborted) return;
                this.pendingBytes -= delivery.bytes;
                if (failure) this.reportError(failure.err);
                delivery = this.queue.shift();
            }
        } finally {
            this.active = undefined;
        }
    }

    private reportError(err: unknown): void {
        try {
            this.opts.onError?.(err);
        } catch {
            // 错误回调失败时继续处理已接纳事件，避免丢失整个队列。
        }
    }

    private async post(delivery: HttpDelivery, shutdown: AbortSignal): Promise<void> {
        const remaining = Math.ceil(delivery.deadline - performance.now());
        const timeoutError = new DOMException("HTTP 上报超时", "TimeoutError");
        if (remaining <= 0) throw timeoutError;
        const timeout = new AbortController();
        const signal = AbortSignal.any([shutdown, timeout.signal]);
        const timer = setTimeout(() => timeout.abort(timeoutError), remaining).unref();
        try {
            const res = await fetch(this.opts.url, {
                method: "POST",
                headers: { "content-type": "application/json", ...this.opts.headers },
                ...(delivery.body === undefined ? {} : { body: delivery.body }),
                signal,
            });
            // 投递结果由 HTTP 状态决定，正文无需读取，也可能已被底层关闭。
            await res.body?.cancel().catch(() => undefined);
            signal.throwIfAborted();
            if (!res.ok) {
                throw new Error(`HTTP 上报失败: ${res.status} ${res.statusText}`);
            }
        } finally {
            clearTimeout(timer);
        }
    }
}
