# OneBot 11 协议

## 1. 代码位置

| 文件 | 职责 |
|---|---|
| `packages/adapter/src/onebot11/adapter.ts` | 适配器主体：订阅 kernel 事件、翻译广播、请求分发 |
| `action/index.ts` + `action/**` | 79 个动作的注册表与实现 |
| `api/one-bot-api.ts` | 动作依赖聚合（kernel API、message_id 映射、uin/uid 转换） |
| `helper/` | CQ 码/消息段编解码、事件翻译、通知/请求翻译、sysmsg 解码、message_id 映射 |
| `transport.ts` | HTTP/WS 多实例传输装配与鉴权 |

## 2. 传输

| 方向 | 形态 | 用途 |
|---|---|---|
| 反向 HTTP | `httpServers[]` | 第三方 POST `{action, params, echo}` 调用动作 |
| 反向 WS | `wsServers[]` | 第三方 WS 连入，双向收发；事件广播，echo 透传 |
| 正向 HTTP | `httpPostUrls[]` | 事件 POST 到第三方（Webhook，fire-and-forget） |
| 正向 WS | `wsReverseUrls[]` | 主动连第三方，双向；带重连、心跳、证书选项 |

- 四类实例都可配置多个，字段与默认值见 [configuration.md](../guides/configuration.md)。
- 鉴权 token 可在协议级设置，实例级覆盖。HTTP/WS 接受
  `Authorization: Bearer <token>`、裸 `Authorization: <token>` 或 `?access_token=<token>`；
  WS 鉴权失败以 **4401** 关闭。
- 正向 WS 握手带 `X-Self-ID`、`x-client-role: Universal`、`User-Agent: OneBot/11`，
  与 Koishi 等客户端的连接识别约定一致。
- 心跳分两层：`heartbeatInterval` 是 meta 事件间隔；`wsServers[].heartbeatInterval` /
  `wsReverseUrls[].heartbeatInterval` 是 WS ping 间隔。

## 3. 请求与动作

请求信封：

```json
{ "action": "send_msg", "params": { "...": "..." }, "echo": "optional" }
```

- `params` 可省略，按 `{}` 处理；动作内部用 zod 校验。
- 成功：`{ retcode: 0, status: "ok", data, message: "" }`。
- 参数校验失败：HTTP 入口 `retcode=400`，WS 入口 `retcode=1400`。
- 未知 action / 缺 action：`retcode=404`。
- 业务错误按 kernel `KernelErrorCode` 映射：

| KernelErrorCode | retcode |
|---|---|
| `SEND_FAILED` | 100 |
| `PERMISSION_DENIED` | 101 |
| `NOT_FOUND` | 102 |
| `TIMEOUT` | 103 |
| `NOT_LOGIN` | 104 |
| `INVALID_PARAM` | 105 |
| `INVALID_STATE` | 106 |
| `UNKNOWN` | 999 |

- WS 请求带 `echo` 时，响应原样带回。

### 动作面（79 个）

动作全部注册在 `action/index.ts` 的 `createOb11ActionRegistry`，按域拆文件：

| 域 | 数量 | 代表动作 |
|---|---|---|
| 消息 | 15 | `send_msg`、`send_private_msg`、`send_group_msg`、`delete_msg`、`get_msg`、历史消息、已读、`get_image`、`get_record`、`fetch_ptt_text`、`set_msg_emoji_like` |
| 合并转发/在线状态 | 7 | `send_group_forward_msg`、`send_private_forward_msg`、`get_forward_msg`、`forward_group_single_msg`、`forward_friend_single_msg`、`set_online_status`、`set_diy_online_status` |
| 查询 | 6 | `get_login_info`、`get_group_info`、`get_group_list`、群成员查询、`get_friend_list` |
| 群管 | 10 | 踢/禁言/全员禁言/管理员/名片/群名/退群、精华设置与删除、`get_group_at_all_remain` |
| 好友 | 6 | 好友申请、备注、删除、分类列表、可疑申请读写 |
| 系统 | 9 | `get_status`、`get_version_info`、`clean_cache`、`can_send_image`、`can_send_record`、`get_robot_uin_range`、`download_file`、`bot_exit`、`set_restart` |
| 群通知 | 3 | `set_group_add_request`、`get_group_system_msg`、`get_group_shut_list` |
| 票据 | 2 | `get_clientkey`、`get_cookies` |
| 资料/点赞/翻译 | 5 | `set_self_longnick`、`set_qq_profile`、`set_qq_avatar`、`translate_en2zh`、`send_like` |
| 群文件 | 9 | 根目录/文件夹查询、系统信息、创建/删除/重命名/移动/转存 |
| 群空间/Web/陌生人 | 7 | `get_stranger_info`、`get_csrf_token`、`get_credentials`、群申请查询、`get_essence_msg_list`、`get_group_honor_info` |

“79 个”是注册的动作名数量（含别名变体，如 `mark_msg_as_read` 的私聊/群聊细分、
`get_csrf_token` / `get_credentials`、`get_image` / `get_record`）。具体名称与参数 schema
以 `action/index.ts` 与各动作文件为准。

## 4. 事件

### 4.1 消息事件

- `message_type=group`：`sub_type=normal`；`group_id`、`user_id`、`sender`（nickname/card/
  role）、`message`、`raw_message`、`font`。
- `message_type=private`：`sub_type=friend` 或 `group`（临时会话）。
- `message` 格式由 `messagePostFormat` 决定：`array`（消息段数组）或 `string`（CQ 码）；
  `raw_message` 始终是 CQ 码字符串。
- 默认不上报机器人自己发的消息；`reportSelfMessage=true` 时上报。

### 4.2 通知事件

已接线的来源：

| notice_type | 来源 |
|---|---|
| `group_upload` | 含 fileElement 的群消息；`groupUploadAsNotice=true` 时替代 message 事件 |
| `group_increase` / `group_decrease` | 群成员变动的 grayTip |
| `group_admin` | 管理员变更 grayTip |
| `group_ban` | 禁言 grayTip |
| `group_recall` / `friend_recall` | 撤回 grayTip（群聊/私聊分流） |
| `friend_add` | `BuddyCache` 好友快照 diff |
| `notify`（poke） | 戳一戳 grayTip；字段仍在真实事件校准中 |
| `offline_file` | `Msg/onRecvOfflineFileMsg`；payload 形状防御性收窄，未知形状只打校准日志 |

已定义但当前未广播/未接线：

- `group_card` / `group_title` / `group_sign`：来自 `Msg/onRecvSysMsg` protobuf；解码器已上线，
  但识别表 `KIND_TABLE` 为空（缺真实样本），命中前只写结构化校准日志。
- `group_essence`：`Group/onGroupEssenceListChange` 目前只打原始校准日志。
- `msg_emoji_like`：没有推送回调；当前只有 `set_msg_emoji_like` 动作，没有对应的读取动作。
- `onRecvOnlineFileMsg`：OB11 无对应通知，只打 raw 日志。

### 4.3 请求事件

- `request_type=group`：`Group/onGroupNotifiesUpdated` 的未处理邀请/申请；doubt 通知跳过。
- `request_type=friend`：`Buddy/onBuddyReqChange`；部分 payload 字段（如留言 words）仍在
  真实事件校准。

### 4.4 元事件

- 适配器启动时广播一次 `lifecycle` / `sub_type=enable`。
- `heartbeat` 按 `heartbeatInterval` 定时广播，`status` 与 `get_status` 同构；`0` 关闭。
- 适配器停止时不额外广播 `disable`（当前实现只发 enable）。

## 5. ID 映射

- `message_id`：协议侧 int32，由 `MessageUnique` 为每个 NT `msgId` 分配并双向映射，同时记录
  `Peer` 供 `delete_msg` / `get_msg` 反查；溢出后复用已释放槽位。
- `user_id`：QQ uin；`group_id`：群号（群消息的 `peerUid` 就是群号）。
- 接收方向：`at` 的 uid → uin（批量 `uidToUin`，失败原样）；`reply` 的 NT msgId → OB11
  message_id（反查不到原样）。
- 发送方向：`at` 的 uin → uid（批量 `uinToUid`，失败交给 QQ 端判断）；`reply` 的 OB11 id →
  NT msgId；私聊 `user_id` 经 uin → uid 得到 `peerUid`。
- 私聊 `Peer` 为 `{ chatType: C2C, peerUid: uid }`；群聊为 `{ chatType: GROUP, peerUid: 群号 }`。

## 6. 配置要点

完整字段见 [configuration.md](../guides/configuration.md)。OB11 特有的是：

- `messagePostFormat`：`array` / `string`。
- `groupUploadAsNotice`：群文件报 `group_upload` notice 还是 message 的 file 段。
- `reportSelfMessage`：是否上报自己发的消息。
- 正向上报的 `x-self-id` 用于 Koishi 等接收端识别 bot。
- 旧单对象传输字段（`http` / `httpPost` / `ws` / `wsReverse`）已移除，不做迁移。

## 7. 已知缺口

- sysmsg 识别表为空：`group_card` / `group_title` / `group_sign` 暂不广播，等真实样本登记规则。
- `offline_file`、poke、好友申请的部分 payload 字段仍是“防御性收窄 + 校准日志”状态。
- `group_essence` 只有原始日志，没有翻译事件。
- 消息事件的 `sender.role` 目前固定为 `"member"`，尚未接群缓存判定 owner/admin。
- `group_recall` / `friend_recall` 的 `message_id` 取自 grayTip 的 `msgSeq`，与消息事件的
  `MessageUnique` int32 映射不是同一空间，不能直接按它反查原消息。
- 通用 `send_msg` 的 canonical 发送覆盖 text / at / face / image / voice / reply /
  json（ARK 卡片透传，`bytesData` 装卡片 JSON 字符串），以及经
  `MsgApi` 预处理的 video；`file` / `forward` / `xml` 不走通用发送（合并转发用专用
  动作，群文件用群文件动作）。
- IPC 桥模式只启动接收链路（`subscribeOnly`）：不装配 HTTP/WS、不起心跳、不广播 lifecycle；
  动作名整表挂到 IPC 动作表供外部驱动调用。
