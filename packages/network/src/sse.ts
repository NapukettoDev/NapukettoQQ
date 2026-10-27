/**
 * SSE 事件流原语（协议无关，ADR-002）
 *
 * 纯 HTTP 语义（text/event-stream + data: 行 + 空行帧）：把「客户端接入 → 推送 →
 * 断开清理」抽象为 SseClient，帧格式按 SSE 规范。传输装配由 HttpServer 的
 * onRawRequest 注入点承接（与 /api 同端口共存），本模块不持有端口。
 */

/** SSE 客户端（一条已建立的事件流连接）。 */
export interface SseClient {
    /**
     * 推送一条事件。data 必须是不含换行的单行文本（SSE 帧按行切分）；
     * event 省略时不写 event: 行（客户端按默认 message 事件收）。
     */
    send(data: string, event?: string): void;
    /** 服务端主动关闭流（客户端收到流结束）。 */
    close(): void;
}

/**
 * SSE 接入回调：客户端连接建立时调用一次。
 * 返回退订函数（可选）——客户端断开（stream cancel）或服务端 close 后调用。
 */
export type SseHandler = (client: SseClient) => (() => void) | undefined;

/** SSE 响应固定头（流式、禁缓存、保活）。 */
const SSE_HEADERS: Record<string, string> = {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
};

/**
 * 构造 SSE 流式 Response。
 *
 * handler 在 Response 构造时同步执行（ReadableStream start 即时回调），
 * 客户端注册因此发生在响应返回前，无竞态窗口。send/close 在流关闭后
 * 调用为静默 no-op（客户端断开竞态）；断开清理统一走 cancel → 退订。
 */
export function createSseResponse(handler: SseHandler): Response {
    const encoder = new TextEncoder();
    let closed = false;
    let unsubscribe: (() => void) | undefined;
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            const client: SseClient = {
                send(data, event) {
                    if (closed) {
                        return;
                    }
                    try {
                        const prefix = event !== undefined ? `event: ${event}\n` : "";
                        controller.enqueue(encoder.encode(`${prefix}data: ${data}\n\n`));
                    } catch {
                        // enqueue 失败 = 流已被底层断开关闭：置位并退订（与 cancel 等价）
                        closed = true;
                        unsubscribe?.();
                    }
                },
                close() {
                    if (closed) {
                        return;
                    }
                    closed = true;
                    try {
                        controller.close();
                    } catch {
                        // 已关闭（竞态），忽略
                    }
                },
            };
            unsubscribe = handler(client);
        },
        cancel() {
            closed = true;
            unsubscribe?.();
        },
    });
    return new Response(stream, { headers: { ...SSE_HEADERS } });
}
