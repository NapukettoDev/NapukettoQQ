---
"@napuketto/loader": patch
---

fix(loader): 协议事件隔离——一协议一 EventBroadcaster，Satori 段存在才装配

此前 OB11 / Satori / Milky 三个适配器共用同一个 `EventBroadcaster`，各协议把传输
注册到同一实例，任一协议 emit 的事件会推给所有协议的客户端：只配
`[accounts.onebot11]` 的账号也能在 OB11 WS 端口收到 Satori 形态事件
（`{"op":0,"body":{...}}` 夹在合法 `post_type: meta_event` 心跳之间），多协议同时
启用时事件流不可判型。

- 每协议独立广播器（`ob11Broadcaster` / `satoriBroadcaster` / `milkyBroadcaster`），
  只传给对应 adapter；Kurobot 是纯客户端出向协议，无广播器（不变）。
- Satori 改为「账号段非空才装配」，与 Kurobot / Milky 同范式；未配置 satori 的账号
  不再订阅 kernel 事件、不再向空传输广播。teardown 判空后 stop。
- IPC 桥（`ipc-ob11.ts`）的广播器不动——独立进程边界。
- 单测补充：只有 `[accounts.onebot11]` 时 satori 构造器零调用；OB11 + Satori 同时
  启用时两者收到的 broadcaster 不是同一实例。
