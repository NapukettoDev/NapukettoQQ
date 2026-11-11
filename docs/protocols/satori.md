# Satori 协议

> Satori HTTP RPC / WS 事件适配器：QQ 群与私聊映射为 guild / channel / user，消息内容
> 使用 XML 风格元素。源码入口 `packages/adapter/src/satori/`。

## 配置方式

```toml
[accounts.satori]
token = "change-me"     # 空 = 不鉴权
# cacheDir = "<账号目录>/cache"

[[accounts.satori.httpServers]]
enabled = true
host = "127.0.0.1"
port = 5500

[[accounts.satori.wsServers]]
enabled = true
port = 5501
```

只有协议段非空才装配。全量字段与默认值见 `packages/adapter/src/satori/helper/config.ts`；
实例级 `token` 可覆盖协议级。

## 传输

- **HTTP RPC**：`POST /v1/{resource}.{method}`，如 `/v1/message.create`。其他方法 405，
  非 `/v1/` 或未知动作 404，平台支持但未实现 501，鉴权失败 401。
- **WS 事件**：路径固定 `/v1/events`；客户端 `IDENTIFY`（`body.token` 可选）→ 服务端
  `READY`（`logins` / `proxy_urls`）→ `PING`/`PONG` → 服务端推送 `EVENT`。
- 配了 token 时 `IDENTIFY` token 不符则不响应，客户端超时断开。当前不做会话恢复：
  `IDENTIFY.body.sn` 被忽略，重连只拿当前状态。

## 能力速查

表头源码：`packages/adapter/src/satori/action/`。平台不支持或未实现的动作统一返回 501。

| 域 | 动作 |
|---|---|
| 消息 | `message.create`、`message.get`、`message.list`、`message.delete` |
| 频道 | `channel.get`、`channel.list` |
| 用户 | `user.get`、`user.channel.create` |
| 群组 | `guild.get`、`guild.list`、`guild.approve` |
| 群成员 | `guild.member.get`、`guild.member.list`、`guild.member.kick`、`guild.member.mute`、`guild.member.approve` |
| 好友 | `friend.list`、`friend.delete`、`friend.approve` |
| 登录/表态 | `login.get`、`reaction.create`、`reaction.delete` |

返回 501：`message.update`、`channel.create/update/delete/mute`、
`guild.member.role.set/unset`、`guild.role.list/create/update/delete`、
`reaction.clear/list`。

- `guild` 映射为 QQ 群；`guild.id` = 群号，`channel.id` = 群号（群聊）或对端 uin（私聊）。
- `guild.member.list` 最多返回 100 条，超出给 `next`；缓存优先，未命中直查原生。
- `guild.approve` / `guild.member.approve` 的 `message_id` 是群通知 seq；
  `friend.approve` 的 `message_id` 是申请方 uin。
- `user.channel.create` 不真正创建频道：QQ 私聊频道就是与对端 uin 的既有会话。
- `message.list` 用消息 ID 作游标，`around` 不支持；`message.create` 回显原始 content。

## 事件

| 事件 | 来源 |
|---|---|
| `message-created` | `Msg/onRecvMsg` 普通消息 |
| `message-deleted` | grayTip `REVOKE`（群聊/私聊） |
| `guild-member-added` | grayTip `GROUP` + `MEMBER_ADD` |
| `guild-member-removed` | grayTip `GROUP` + `QUIT` |
| `login-updated` | 适配器启停广播（上线/离线） |

- 事件 `sn` 从 1 递增；事件体带最小 `login` 字段。群成员变动填 `guild`、`channel`、
  `member`、`user`，有操作者时填 `operator`。
- `message-deleted` 的 `message.id` 取自 grayTip `msgSeq`，`message-created` 用 NT `msgId`，
  两者不保证直接配对。
- 好友申请 / 群申请事件暂未广播。

## 元素

`content` 是 XML 风格字符串，解析容错：实体、注释、无值属性、未配对标签。

| canonical | Satori |
|---|---|
| text / at / image / face / voice / video / file / reply | 文本节点 / `<at>` / `<img>` / `<emoji>` / `<audio>` / `<video>` / `<file>` / `<quote>` |
| forward | `<message forward id="首个消息 id">` |
| json / xml / unknown | 忽略（无法表达） |

发方向：`text` / `at` / `emoji` / `quote` / `br`；`message` 展开子元素，带 `forward` 属性
转 canonical forward；`b` / `i` / `u` / `s` / `code` / `p` 等排版元素展开子元素。
`img` / `audio` / `video` / `file` 的 `src` 支持 `internal:`、`http(s)` 下载与本地路径；
audio 非 silk 转码，video 非 mp4 用 ffmpeg 归一化（失败原样透传）；`author` / `sharp` /
`a` / `button` 忽略。

## ID 映射

- `user.id` = uin；`login.user.id` = 机器人 uin；`guild.id` = 群号。
- `channel.id`：群聊 = 群号，私聊 = 对端 uin；`channel.type` 0 = 群聊，1 = 私聊。
- `message.id` = NT `msgId` 字符串（不是 OB11 的 int32 映射）。
- 群号与 uin 都是数字，`SatoriApi` 维护 `channel_id → isGroup` 缓存；未命中先按群号查，
  失败再按私聊处理。

## 已知限制

- 会话恢复（`sn`）未实现；`/v1/meta` 不可达（路径解析要求 `resource.method`）。
- `message.list` 的 `around` 不支持，分页是近似实现。
- `file` 元素可接收/解析，但通用发送路径不支持 file，Satori 也没有群文件发送动作。
- 频道管理、角色管理、消息编辑等返回 501；好友/群申请事件未广播。
- `message-created` 未过滤机器人自己发送的消息（与 OB11 的 `reportSelfMessage` 不同）。
- `message.create` 的 `referrer` 透传但忽略（QQ 不区分主动/被动消息）。
