# @napuketto/adapter

NapukettoQQ 协议适配器容器：core 框架 + OneBot 11 / Satori / KuroBot / Milky。

- **core**：协议适配器生命周期框架（`BaseProtocolAdapter` / 动作执行内核 `runAction` / 动作注册表 / `ConfigBase`）
- **onebot11**：动作注册表与 HTTP / WebSocket / 反向 WebSocket 多实例传输，鉴权 + 心跳
- **satori**：HTTP RPC / WS 事件，XML 元素编解码
- **kurobot**：KuroBridge 出向 WS 客户端，QQ 群 ↔ Minecraft 互通
- **milky**：单端口 HTTP + SSE / WS 事件流 + WebHook

## 子路径

- `@napuketto/adapter/core` — 框架层
- `@napuketto/adapter/onebot11` — OneBot 11 实现
- `@napuketto/adapter/satori` — Satori 实现
- `@napuketto/adapter/kurobot` — KuroBot 实现
- `@napuketto/adapter/milky` — Milky 实现

## 约束

- 只认识 kernel 的语义化 API / 事件通道 / 缓存，不认识原生
