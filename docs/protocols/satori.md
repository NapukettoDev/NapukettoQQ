# Satori 协议

## 1. 代码位置

| 文件 | 职责 |
|---|---|
| `packages/adapter/src/satori/adapter.ts` | 适配器主体：订阅 kernel 消息、广播事件、启停传输 |
| `action/` | 动作注册表与实现（22 个已实现 + 13 个 501） |
| `api/satori-api.ts` | 动作依赖聚合：kernel API、self、cacheDir、channel 类型缓存 |
| `transport.ts` | HTTP RPC 与 WS 事件服务装配、鉴权、错误状态 |
| `helper/element/` | 元素 XML 解析/渲染、canonical ↔ Satori 转换、媒体下载/转码 |
| `helper/ids.ts` | QQ 平台 ID 语义（channel/guild/user/login） |

## 2. 传输

### HTTP RPC

- 路径：`POST /v1/{resource}.{method}`，如 `/v1/message.create`。
- 其他方法返回 405；非 `/v1/` 或未知动作返回 404；平台支持但未实现返回 501；鉴权失败
  由 HTTP server 返回 401。
- 鉴权：配置 token 后要求 `Authorization: Bearer <token>`。

### WS 事件服务

- 路径固定 `/v1/events`。
- 信令：
  - 客户端 `IDENTIFY`（`body.token` 可选）→ 服务端 `READY`（`logins` / `proxy_urls`）。
    配了 token 时 token 不符则不响应，客户端超时断开。
  - `PING` → `PONG`。
  - 事件由服务端以 `EVENT` 信令推送。
- 当前不做会话恢复：`IDENTIFY.body.sn` 被忽略，直接返回当前状态。

## 3. 动作

### 已实现（22 个）

| 域 | 动作 |
|---|---|
| 消息 | `message.create`、`message.get`、`message.list`、`message.delete` |
| 频道 | `channel.get`、`channel.list` |
| 用户 | `user.get`、`user.channel.create` |
| 群组 | `guild.get`、`guild.list`、`guild.approve` |
| 群成员 | `guild.member.get`、`guild.member.list`、`guild.member.kick`、`guild.member.mute`、`guild.member.approve` |
| 好友 | `friend.list`、`friend.delete`、`friend.approve` |
| 登录 | `login.get` |
| 表态 | `reaction.create`、`reaction.delete` |

说明：

- `guild` 在 QQ 平台映射为群组；`guild.id` = 群号，`channel.id` = 群号（群聊）或对端 uin
  （私聊）。
- `guild.member.list` 最多返回 100 条，超出时给 `next` 提示；缓存优先，未命中直查原生。
- `guild.approve` / `guild.member.approve` 的 `message_id` 是群通知 seq；`friend.approve`
  的 `message_id` 是申请方 uin。
- `user.channel.create` 不真正创建频道：QQ 私聊频道就是与对端 uin 的既有会话。
- `message.list` 用消息 ID 作游标拉取；`around` 方向不支持，分页语义是近似实现。
- `message.create` 返回的 `content` 是原始输入回显，不做规范化重渲染。

### 返回 501 的动作（13 个）

QQ 平台不支持或适配器未实现，统一注册 `NotImplementedAction` 返回 501：

```
message.update
channel.create / channel.update / channel.delete / channel.mute
guild.member.role.set / guild.member.role.unset
guild.role.list / guild.role.create / guild.role.update / guild.role.delete
reaction.clear / reaction.list
```

## 4. 事件

当前广播的事件类型：

| 事件 | 来源 |
|---|---|
| `message-created` | `Msg/onRecvMsg` 普通消息 |
| `message-deleted` | grayTip `REVOKE`（群聊/私聊） |
| `guild-member-added` | grayTip `GROUP` + `MEMBER_ADD` |
| `guild-member-removed` | grayTip `GROUP` + `QUIT` |
| `login-updated` | 适配器启停时广播（上线/离线） |

- 事件 `sn` 从 1 递增；事件体带最小 `login` 字段（规范）。
- 群成员变动同时填 `guild`、`channel`、`member`、`user`，有操作者时填 `operator`。
- `message-deleted` 的 `message.id` 取自 grayTip 的 `msgSeq`，而 `message-created` 用 NT
  `msgId`；两者当前不保证能直接配对。
- 好友申请 / 群申请事件暂未广播（grayTip 结构未校准，OB11 侧走主动查询/通知源）。

## 5. 元素

`content` 是 XML 风格字符串，支持转义实体、注释、无值属性、未配对标签容错。

收方向（canonical → Satori）：

| canonical | Satori |
|---|---|
| text | 文本节点 |
| at | `<at id="uin" name="显示名">`，全体为 `id="all"` |
| image | `<img src="...">` |
| face | `<emoji id="...">` |
| voice | `<audio src="...">` |
| video | `<video src="...">` |
| file | `<file src="..." title="...">` |
| reply | `<quote id="...">` |
| forward | `<message forward id="首个消息 id">` |
| json / xml / unknown | 忽略（无法表达） |

发方向（Satori → canonical）：

- `text` / `at` / `emoji` / `quote` / `br`；`message` 展开子元素，带 `forward` 属性时转
  canonical forward；`b` / `i` / `u` / `s` / `code` / `p` 等修饰或排版元素展开子元素。
- `img` / `audio` / `video` / `file`：`src` 支持 `internal:` 路径、`http(s)` 下载、本地路径；
  audio 非 silk 会转码；video 非 mp4 用 ffmpeg 归一化（失败原样透传）。
- `author` / `sharp` / `a` / `button` 忽略（QQ 不支持）。

## 6. ID 映射

- `user.id` = QQ uin；`login.user.id` = 机器人 uin。
- `channel.id`：群聊 = 群号，私聊 = 对端 uin；`channel.type` 0 = 群聊，1 = 私聊。
- `guild.id` = 群号；QQ 群组与群聊频道重合，平台特性标记 `guild.plain`。
- `message.id` = NT `msgId` 字符串（不是 OB11 的 int32 映射）。
- 群号与用户 uin 都是数字，`channel_id` 无法仅凭格式区分。`SatoriApi` 维护
  `channel_id → isGroup` 缓存；未命中时先尝试按群号查询，失败再按私聊处理（uin → uid）。

## 7. 配置

字段见 [configuration.md](../guides/configuration.md)。要点：

- `token` 全局鉴权；HTTP 实例与 WS 实例可用自己的 `token` 覆盖。
- `cacheDir` 是媒体资源下载目录，缺省 `<账号目录>/cache`。
- HTTP 默认端口 5500，WS 默认 5501；每个实例独立监听。
- Satori 没有正向 HTTP/WS 客户端，只提供 server。

## 8. 已知限制

- WS `IDENTIFY` 的会话恢复（`sn`）未实现；断线重连只能拿当前状态。
- `/v1/meta` 当前不可用：路径解析要求 `resource.method`，`meta` 会被 404；`transport.ts`
  里的 meta 分支尚未可到达。
- `message.list` 的 `around` 方向不支持；分页语义是近似实现。
- `file` 元素可以接收/解析，但通用发送路径不支持 `file`（canonical 发送只覆盖
  text/at/face/image/voice/reply + 预处理 video）；Satori 也没有群文件发送动作。
- 好友申请 / 群申请事件未广播；频道管理、角色管理、消息编辑等返回 501。
- `message-created` 当前未过滤机器人自己发送的消息（与 OB11 的 `reportSelfMessage` 行为不同）。
- `message.create` 的 `referrer` 透传但忽略（QQ 不区分主动/被动消息）。
