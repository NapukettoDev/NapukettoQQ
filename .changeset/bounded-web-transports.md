---
"@napuketto/kernel": patch
"@napuketto/network": minor
"@napuketto/adapter": minor
---

为群空间 WebApi 的精华分页和荣誉查询加入 HTTP 期限、正文上限和可选取消信号。
Webhook 按目的地址串行投递，限制等待事件与正文总量，默认从提交起 5 秒超时，关闭丢弃待发送事件并取消在途请求。
WsClient 入站消息默认限制为 32 MiB，独立 WsServer 关停发送 1001 并在 250 ms 宽限期后终止剩余连接。
直接使用 HttpClient 的调用方可配置正整数 `timeoutMs` 并用 `onError` 观察拒收，关闭后调用 `open()` 恢复。
直接使用 WsClient 且业务确需大于 32 MiB 单条消息时，可配置 `maxPayloadBytes`。
