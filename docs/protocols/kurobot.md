# KuroBot 协议

## 1. 定位

KuroBot 是第三条协议，形态与其他两条不同：**纯出向 WS 客户端**，把 QQ 群消息送到
Minecraft 服务端的 KuroBridge 插件，并把游戏事件渲染回 QQ 群。没有 HTTP 服务、没有事件
广播器、没有第三方接入门面。

- 协议名：`kurobridge-ws`；子协议：`kurobridge-ws.v1`；协议版本：`0.4.0`。
- schema 为镜像实现，SSOT 是 KuroBridge 的 `bridge/protocol`；本仓用 golden 帧对表测试锁
  形状，将来可切换为真依赖。
- 代码：`packages/adapter/src/kurobot/{adapter,connection,schema,translate,config}.ts`。

## 2. 线格式

单行 JSON 文本帧：

```json
{ "header": { "type": "chat" }, "body": { "...": "..." } }
{ "header": { "type": "command", "id": "uuid" }, "body": { "...": "..." } }
```

- 事件帧无 `id`；请求/响应帧必须有 UUID `id`。
- 解析后统一转成扁平消息 `{ type, id?, body }`。
- 已知帧：`hello` / `hello_ack` / `ping` / `pong` / `chat` / `join` / `leave` / `death` /
  `status` / `bindings_updated` / `command` / `command_result` / `query` / `query_result`。

## 3. 连接

`KurobotConnection` 自建，不复用 `network.WsClient`，原因是四个协议语义：子协议握手、
应用层心跳、每次 open 重发 hello、close-code 感知退避。

状态机：

```
connecting → establishing（hello 已发，等 hello_ack）
  → established（应用层 ping）
  ↔ backoff（1s / 2s / … / 60s 封顶）
```

- 连接时带 `Sec-WebSocket-Protocol: kurobridge-ws.v1`。
- 每次 open 立即发 `hello`（新 UUID），内容：`peerId`（本账号 uin）、`platform: "qq"`、
  `version`（adapter 包版本）、`protocolVersion: "0.4.0"`、`client`（缺省
  `napukettoqq/<adapter 版本>`）、非空 `token`。
- `hello_ack ok:true` → 建立，记录 `channelBindings` 快照；`ok:false` → 永久停止。
- established 后每 `pingIntervalMs` 发应用层 `ping`（默认 15s；服务端空闲阈值 30s，
  WS 层 ping 不重置它的计时）。
- close `1002` / `1008` → 永久停止；其他关闭码 → 指数退避重连；建立成功后 attempt 清零。
- 未 established 时发送直接丢弃，不积压。
- 未知帧：事件帧（无 id）debug 忽略；请求帧（带 id）回同 id `<type>_result`
  `{ ok:false, error:"unknown frame type" }`；`_result` 结尾的帧不回执，防乒乓。

## 4. QQ → 游戏

只处理群聊消息：

1. 过滤本账号自己发的消息（`senderUin === selfUin`），防 QQ→MC→QQ 回环。
2. canonical 元素降级为单行文本：text 原文、at → `@显示名` / `@全体成员`、
   image → `[图片]`、face → `[表情]`、reply → `[回复]`；voice/video/file/forward/json/xml
   等无法表达的类型静默跳过。
3. 以 `commandPrefix`（默认 `/`）开头 → 发 `command` 请求：
   `{ command, source: { channel, userId } }`。空命令忽略；**命令不做绑定过滤**（管理员
   判定在服务端）。
4. 普通聊天 → 仅当群号在 `bindings` 集合中才发 `chat` 事件；集合为空表示全部不发。
   `hello_ack.channelBindings` 建立初始集合，`bindings_updated` 全量替换。

## 5. 游戏 → QQ

| 帧 | 处理 |
|---|---|
| `chat` | 按 `chatTemplate` 渲染（`{player}` / `{content}`）后发群 |
| `join` | 按 `joinTemplate` 渲染后发群 |
| `leave` | 按 `leaveTemplate` 渲染后发群 |
| `death` | 按 `deathTemplate` 渲染；`message` 为空时以“死亡了”代入 |
| `status` | 仅缓存最近一帧，不发群（防刷屏） |
| `bindings_updated` | 全量替换绑定集合 |
| `command_result` | 按请求 UUID 找回发群号 → 渲染回群 → 删除 pending |
| `query_result` | 按请求 UUID 匹配：`bindings` 刷新绑定集合；`status` 记录 |

- `command_result` 帧体没有 channel 字段，adapter 用 `pendingCommands: Map<UUID, channel>`
  关联；连接重建/握手时清空 pending。
- `ok:false` → `命令失败：<error>`；`ok:true` 且无 output → “（命令执行成功，无输出）”。
- 所有发群文本超过 1500 个 UTF-16 码元时截断，追加 `…(截断)`。
- 群消息发送失败只记 error 日志，不影响连接与收链路。

## 6. 配置

`[accounts.kurobot]` 段非空即启用，且必须含 `url`（`ws://` 或 `wss://`）。字段与默认值见
[configuration.md](../guides/configuration.md)：

```toml
[accounts.kurobot]
url = "ws://127.0.0.1:25580"
# token = ""
# commandPrefix = "/"
# pingIntervalMs = 15000
# chatTemplate = "[{player}] {content}"
# joinTemplate = "{player} 加入了服务器"
# leaveTemplate = "{player} 离开了服务器"
# deathTemplate = "{player} {message}"
```

装载时只有段非空才装配；非空段必须含 `url`，否则 zod 校验失败导致装配失败。空段
（`[accounts.kurobot]` 下没有任何键）等同未启用，不会报错。

## 7. 已知限制

- 协议仍是镜像实现；`@kuro-bridge/protocol` 发版后应切换真依赖，把 golden 对拍改为互验。
- 富文本只做降级：MC → QQ 纯文本；QQ → MC 图片/语音/文件等只给占位或跳过，协议本身也
  未定义富文本段。
- `status` 只有缓存与内部 `query("status")` 能力，没有 QQ 群命令触发面。
- `wss://` 的证书选项（如 `rejectUnauthorized`）未透传；自签证书场景暂不可用。
- 与 KuroBridge `peer-guide.md` 的交叉复核、真实服务器 + QQ 扫码的端到端验收仍需人工完成。
