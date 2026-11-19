---
"@napuketto/adapter": patch
"@napuketto/network": patch
---

修复 Satori WS 事件服务越权泄露：配了 `token` 时，未认证连接此前仍会收到全部 `EVENT`
（token 校验失败只是「不响应」，连接保持 OPEN 并留在广播集合里）。

- Satori 新增 `SatoriEventHub`：接管 wsServers 的 `send`/`open`/`close`，只向完成
  `IDENTIFY` 的连接广播事件；token 不符或连接建立后 10s 内未 `IDENTIFY` 以 close code
  `4004` 断开。token 为空仍表示不鉴权（连接即视为已认证）。
- `WsServer` 新增 `onConnection` 钩子，并把连接作为 `onRequest` 第三参透传，供
  「连接后才认证」的协议登记认证状态（可选能力，向后兼容）。
