# Milky 协议

> 与 OB11 / Satori / KuroBot 并行的第四个协议适配器，对齐 Milky 1.3.0（`get_impl_info` 上报
> `milky_version = "1.3"`）。源码入口 `packages/adapter/src/milky/`，机制见
> [adapter design](../../packages/adapter/docs/design.md)。

## 配置方式

`napuketto.toml` 的 `[accounts.milky]` 是账号内嵌协议段：**段存在且 `enabled = true` 才装配**；
段缺失或 `enabled = false` 时为空转（不订阅 kernel 事件、不起传输、不占端口）。

```toml
[accounts.milky]
enabled = true
host = "127.0.0.1"
port = 3001
token = ""                  # 空 = 不校验（仅限内网）
eventModes = ["sse", "ws"]  # /event 允许的连接形态
webhooks = []               # 额外推送地址，可多个
# cacheDir = ".napuketto/cache"
```

- `token` 非空时校验 `Authorization: Bearer <token>`；SSE / WS 允许 `?access_token=` 兜底。
- `webhooks[]` 每个地址各发一份 POST，请求头带 Bearer token，body 与 WS / SSE 推送同构。
- `cacheDir` 是发送 `http(s)://` / `base64://` 媒体时的下载缓存目录；缺省不下载，
  远程媒体发送报参数错误。
- 全量字段、类型与缺省值以 [`config.ts`](../../packages/adapter/src/milky/config.ts) 为准。

HTTP 语义与错误码：

| 情况 | HTTP | 说明 |
|---|---|---|
| 成功 | 200 | retcode 0，带 data |
| 鉴权失败 | 401 | 空 body |
| API 不存在 | 404 | 空 body（路径/方法不符同） |
| Content-Type 非 JSON | 415 | 空 body |
| 参数解析失败 | 200 | retcode -400 |
| 未登录 | 200 | retcode -403 |
| 其他业务错误 | 200 | 自定负数 retcode |

成功信封 `{ status: "ok", retcode: 0, data }`；失败信封
`{ status: "failed", retcode, data: null, message }`。kernel 错误到 retcode 的映射在
`action/error-map.ts`（`-400` 参数、`-403` 未登录，其余按错误类型取自定负数）。

## 传输

- 单端口 HTTP：`POST /api/:api` 调动作（JSON body，无参数也必须传 `{}`）；`GET /event` 推事件。
- `GET /event` 按 `Upgrade: websocket` 头分流：有头走 WS，无头走 SSE；两种形态由
  `eventModes` 控制，关闭的形态返回 404。
- SSE 事件名固定 `milky_event`；WS 只下行，入帧忽略。
- WebHook 为第三条推送路径：主动 POST，fire-and-forget，失败只记 warn 日志。

## 能力速查

源码：`packages/adapter/src/milky/action/`（注册表 `action/index.ts`，按域拆文件）；下表只列
动作名，参数与返回 schema 见各文件。

### 系统

| 动作 | 动作 | 动作 |
|---|---|---|
| get_login_info | get_impl_info | get_user_profile |
| get_friend_info | set_avatar | set_nickname |
| set_bio | get_cookies | get_csrf_token |

### 消息

| 动作 | 动作 | 动作 | 动作 | 动作 |
|---|---|---|---|---|
| send_private_message | send_group_message | get_message | recall_private_message | recall_group_message |
| get_history_messages | get_forwarded_messages | mark_message_as_read | get_custom_face_url_list | get_resource_temp_url |

### 好友

| 动作 | 动作 | 动作 |
|---|---|---|
| get_friend_list | send_profile_like | delete_friend |
| get_friend_requests | accept_friend_request | reject_friend_request |
| send_friend_nudge | get_peer_pins | set_peer_pin |

### 群

| 动作 | 动作 | 动作 | 动作 | 动作 |
|---|---|---|---|---|
| get_group_list | get_group_info | get_group_member_list | get_group_member_info | set_group_name |
| set_group_member_card | set_group_member_admin | set_group_member_mute | set_group_whole_mute | kick_group_member |
| quit_group | get_group_essence_messages | set_group_essence_message | send_group_message_reaction | get_group_notifications |
| accept_group_request | reject_group_request | accept_group_invitation | reject_group_invitation | send_group_nudge |
| get_group_announcements | send_group_announcement | delete_group_announcement | set_group_avatar | set_group_member_special_title |

### 群文件

| 动作 | 动作 | 动作 | 动作 |
|---|---|---|---|
| upload_private_file | upload_group_file | get_group_file_download_url | get_group_files |
| move_group_file | rename_group_file | delete_group_file | persist_group_file |
| create_group_folder | delete_group_folder | rename_group_folder |  |

备注：`upload_group_file` / `upload_private_file` 走闪传；`get_private_file_download_url`
未实现（见下节）。

## 事件

事件信封固定 `{ time, self_id, event_type, data }`；`event_type` 对齐规范 1.3 的联合会话。

| event_type | 原生源 | 备注 |
|---|---|---|
| message_receive | Msg/onRecvMsg | 已接；自消息不上报 |
| message_recall | grayTip revokeElement | 已接 |
| peer_pin_change | RecentContact 会话列表变更 | 已接；需校准 |
| friend_request | Buddy/onBuddyReqChange | 已接 |
| group_join_request | Group/onGroupNotifiesUpdated | 已接 |
| group_invited_join_request | 同上 | 已接 |
| group_invitation | 同上 | 已接 |
| friend_nudge | grayTip aioOp | 需校准（display_* 无源） |
| friend_file_upload | Msg 离线/在线文件回调 | 需校准（file_hash 取 md5） |
| group_admin_change | 无源 | 未接（识别表未登记） |
| group_essence_message_change | sysmsg 732:1 + 列表 diff | 已接；需校准 |
| group_member_increase | grayTip | 已接 |
| group_member_decrease | grayTip | 已接 |
| group_disband | grayTip | 已接 |
| group_name_change | grayTip | 已接 |
| group_message_reaction | sysmsg 732:16 | 已接；user_id 常缺 |
| group_mute | grayTip | 已接 |
| group_whole_mute | grayTip | 已接 |
| group_nudge | grayTip aioOp | 需校准 |
| group_file_upload | 群消息 file 元素 | 已接 |
| bot_offline | Login 断开/登出回调 | 需校准（reason 固定） |

群名片（sysmsg 732:21）只有 OB11 侧识别规则，Milky 1.3 没有对应 `event_type`；
528:349/381/382 多端同步族只写校准日志、不广播。

## 协议差异与限制

- **ID 反查**：`message_seq` ↔ `msgId` 由 adapter 侧 `MessageSeqIndex` 双向登记（每方向
  FIFO 4096 条封顶）；`get_message` / 撤回先查索引，未命中再扫近段历史
  （`fetchMessages` 60 条）兜底，仍未命中抛 `NOT_FOUND`。合并转发另按 resId 存定位索引。
- **合并转发发送**：`messages[]` 逐条作为临时消息发出 → `sendForwardMessage` 组装 →
  best-effort 撤回临时消息（失败只记 warn，转发已发出）。节点发送者恒为机器人：
  `user_id` / `sender_name` / `time` 不参与组装；`title` / `preview` / `summary` / `prompt`
  忽略。forward 段必须单独发送，嵌套或空 `messages` 报 `-400`。
- **文件投递走闪传**：`upload_group_file` / `upload_private_file` 上传文件集后发分享卡片，
  对端收到的不是文件消息，也不进群文件列表；返回 `file_id` 是闪传 fileSetId，不能喂给
  `delete_group_file` / `get_group_file_download_url` 等群文件动作；`parent_folder_id` 仅
  schema 兼容（闪传无目录）。
- **`get_private_file_download_url` 未实现**：NT 私聊下载链接依赖 rkey 与 TriSHA1（规范
  `file_hash` 即 TriSHA1），参数形状未校准，动作未注册。
- **`get_group_file_download_url`**：从群文件根列表按 fileId 取 `url` 字段，仅根目录可达；
  `url` 字段本身待实机确认。
- **`get_resource_temp_url`**：`resource_id` 就是接收段临时链接；`http(s)` / `base64`
  形态原样返回，其余 `NOT_FOUND`；没有独立资源索引。
- **`group_message_reaction`**：原生 push 不带操作者，`user_id` 不可得时省略；
  `reaction_type` 恒 `face`。
- **`bot_offline`**：`reason` 是固定值（`disconnected` / `logout`），真实原因字段待野捕校准。
- **自消息不上报**：`senderUin === self_id` 的消息不产 `message_receive`；群场景文件消息
  产 `group_file_upload` 而不是 `message_receive`。
- **`get_impl_info`**：`milky_version` 固定 `"1.3"`，`qq_protocol_type` 固定 `windows`
  （自建宿主）。
- **许可证边界**：只读 MIT 规范与机读 schema，不读 GPL 系实现源码（含 GPL-2.0-only 的
  LLBot），见 [ADR-025](../architecture/decisions.md)。

## 参考

- 规范站：<https://milky.ntqqrev.org/>
- 通信层：<https://milky.ntqqrev.org/guide/communication>
- 仓库：<https://github.com/SaltifyDev/milky>
