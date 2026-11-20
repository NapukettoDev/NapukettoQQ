---
"@napuketto/network": patch
"@napuketto/adapter": patch
---

修复 M-01 WebSocket 可靠性。启用心跳时以匹配的 pong 判活，超时即回收连接。WS 文本发送按连接检查缓冲上限，超限立即断开且不重放；Satori 仍只向已认证连接推送，Milky 的 WS 事件也受同一上限保护。

`WsClient` 首次自动重连仍等待 `delayMs`，后续连续失败使用有上限的指数退避与抖动。`maxAttempts` 保持有效，连通后重置，显式关闭会取消待重连和进行中的握手。
