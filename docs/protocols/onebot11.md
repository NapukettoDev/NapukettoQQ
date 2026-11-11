# OneBot 11 协议

> NapukettoQQ 的主协议适配器：HTTP / WS / 反向 WS / Webhook 四种接入形态，动作与事件按
> OneBot 11 约定翻译。源码入口 `packages/adapter/src/onebot11/`。

## 配置方式

```toml
[accounts.onebot11]
token = "change-me"           # 空 = 不鉴权（仅本机调试）
messagePostFormat = "array"   # array | string（CQ 码）
heartbeatInterval = 3000      # meta 事件心跳；0 关闭

[[accounts.onebot11.httpServers]]
enabled = true
host = "127.0.0.1"
port = 3000

[[accounts.onebot11.wsServers]]
enabled = true
port = 3001
```

另有 `httpPostUrls`（正向上报）与 `wsReverseUrls`（正向 WS 客户端），字段见
`packages/adapter/src/onebot11/helper/config.ts`。OB11 始终装配；账号没写协议段时使用默认值
（传输数组为空，不监听端口）。

## 传输

| 方向 | 配置 | 用途 |
|---|---|---|
| 反向 HTTP | `httpServers[]` | 第三方 POST `{action, params, echo}` |
| 反向 WS | `wsServers[]` | 第三方 WS 连入，双向收发 |
| 正向 HTTP | `httpPostUrls[]` | 事件 POST 到第三方（Webhook） |
| 正向 WS | `wsReverseUrls[]` | 主动连第三方，带重连与心跳 |

- 鉴权：协议级 `token`，实例级可覆盖；接受 `Authorization: Bearer <token>`、裸
  `Authorization: <token>` 或 `?access_token=`。WS 鉴权失败以 4401 关闭。
- 正向 WS 握手带 `X-Self-ID`、`x-client-role: Universal`、`User-Agent: OneBot/11`。
- 心跳两层：`heartbeatInterval` 是 meta 事件间隔；WS 实例的 `heartbeatInterval` 是 ping。

## 请求与错误

```json
{ "action": "send_msg", "params": { "...": "..." }, "echo": "optional" }
```

- 成功：`{ retcode: 0, status: "ok", data, message: "" }`；WS 请求带 `echo` 时原样带回。
- 参数校验失败：HTTP 入口 400，WS 入口 1400；未知/缺失 action：404。
- 业务错误按 `KernelErrorCode` 映射：

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

## 能力速查

表头源码：`packages/adapter/src/onebot11/action/index.ts`。动作名含别名变体，参数 schema
以各动作文件为准。

| 域 | 代表动作 |
|---|---|
| 消息 | `send_msg`、`send_private_msg`、`send_group_msg`、`delete_msg`、`get_msg`、历史消息、已读、`get_image`、`get_record`、`fetch_ptt_text`、`set_msg_emoji_like` |
| 合并转发/在线状态 | `send_group_forward_msg`、`send_private_forward_msg`、`get_forward_msg`、`forward_group_single_msg`、`forward_friend_single_msg`、`set_online_status`、`set_diy_online_status` |
| 查询 | `get_login_info`、`get_group_info`、`get_group_list`、群成员查询、`get_friend_list` |
| 群管 | 踢/禁言/全员禁言/管理员/名片/群名/退群、精华设置与删除、`get_group_at_all_remain` |
| 好友 | 好友申请、备注、删除、分类列表、可疑申请读写 |
| 系统 | `get_status`、`get_version_info`、`clean_cache`、`can_send_image`、`can_send_record`、`get_robot_uin_range`、`download_file`、`bot_exit`、`set_restart` |
| 群通知 | `set_group_add_request`、`get_group_system_msg`、`get_group_shut_list` |
| 票据/资料 | `get_clientkey`、`get_cookies`、`set_self_longnick`、`set_qq_profile`、`set_qq_avatar`、`translate_en2zh`、`send_like` |
| 群文件 | 根目录/文件夹查询、系统信息、创建/删除/重命名/移动/转存 |
| 文件投递 | `upload_group_file`、`upload_private_file`（闪传，见下） |
| 空间/Web/陌生人 | `get_stranger_info`、`get_csrf_token`、`get_credentials`、群申请查询、`get_essence_msg_list`、`get_group_honor_info` |

`upload_group_file` / `upload_private_file` 走**闪传**：上传文件集后发 `qfile.qq.com` 分享
卡片。对端收到的是卡片而非文件消息，也不进群文件列表；返回的 `file_id` 是闪传文件集 id，
不能喂给群文件动作；`file` 只支持本地路径与 `file://`。

## 事件

- **消息**：`group`（normal）/ `private`（friend / group 临时会话）；`sender.role` 由
  `GroupCache` 判定，缓存缺失惰性回填；`message` 格式由 `messagePostFormat` 决定，
  `raw_message` 恒为 CQ 码；默认不上报机器人自己的消息。
- **通知**：`group_upload`、`group_increase` / `group_decrease`、`group_admin`、
  `group_ban`、`group_recall` / `friend_recall`、`friend_add`、`notify`（poke）、
  `offline_file`、`group_essence`（列表 diff 为唯一发射路径）。
- **请求**：群邀请/申请来自 `Group/onGroupNotifiesUpdated`；好友申请来自
  `Buddy/onBuddyReqChange`；未处理项才推送，未知形状只打校准日志。
- **元事件**：启动广播一次 `lifecycle/enable`；`heartbeat` 按间隔广播，`0` 关闭。

未接线：`group_title` / `group_sign`（sysmsg 判别值缺样本）、`msg_emoji_like`（无推送回调）、
`onRecvOnlineFileMsg`（OB11 无对应通知，只打 raw 日志）。

## ID 映射

- `message_id`：协议侧 int32，由 `MessageUnique` 为每个 NT `msgId` 双向分配并记录 `Peer`，
  供 `delete_msg` / `get_msg` 反查；溢出复用已释放槽位。
- `user_id` = uin；`group_id` = 群号。接收方向 at uid→uin、reply NT msgId→OB11 id；发送
  方向 at uin→uid、reply OB11 id→NT msgId；失败时原样传递。
- 群聊 `Peer` 为 `{chatType: GROUP, peerUid: 群号}`；私聊为 `{chatType: C2C, peerUid: uid}`。

## 已知缺口

- `group_recall` / `friend_recall` 的 `message_id` 取自 grayTip `msgSeq`，与消息事件的
  `MessageUnique` 不是同一空间，不能直接反查原消息。
- `offline_file`、poke、好友申请的部分 payload 仍是防御性收窄 + 校准日志状态。
- 通用 `send_msg` 覆盖 text / at / face / image / voice / reply / json（ARK 透传）与
  预处理 video；`file` / `forward` / `xml` 不走通用发送。
- IPC 桥模式只启动接收链路（`subscribeOnly`），不装配 HTTP/WS、不起心跳、不广播 lifecycle。

> 错误码、字段与边界实测见 [adapter evidence](../../packages/adapter/docs/evidence.md)。
