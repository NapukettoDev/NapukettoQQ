/**
 * 逐条处理消息回调参数（onRecvMsg 实际传的是消息数组，不是单条；
 * 兼容单条对象，过滤无效项）。
 */
export function forEachRawMessage(msgs: unknown, handler: (msg: unknown) => void): void {
    const list = Array.isArray(msgs) ? msgs : [msgs];
    for (const msg of list) {
        if (!msg || typeof msg !== "object") {
            continue;
        }
        handler(msg);
    }
}
