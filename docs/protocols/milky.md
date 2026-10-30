# Milky 协议（P0 已实现 · 规划稿）

> **状态：P1 已实现，P2 批次一已落地**（P0 2026-10-28 / P1 2026-10-30 / P2 批次一
> 2026-10-31，见 §0/§0.5/§0.6 落地面与 §9 勾选）。§6/§7 的状态列与 §9 P2 剩余部分
> 仍是覆盖清单，不是现状描述；全部落地后按 `docs/README.md` 的维护约定改写为现状文档。
>
> **目标协议版本：Milky 1.3.0**（2026-08-07 发布）。`get_impl_info` 上报
> `milky_version = "1.3"`。
>
> 一句话定位：**第四个协议适配器，与 OB11 / Satori / KuroBot 并行，不替代任何现有协议。**

## 0. P0 落地面（2026-10-28，PR 待合并）

- **传输**（`@napuketto/network` 新原语）：SSE 事件流（`createSseResponse`）+
  `HttpServer` 流式响应注入点（`onRawRequest`）与同端口 WS 升级注入点（`onUpgrade`）；
  404/401 支持空 body 响应。
- **适配器**（`packages/adapter/src/milky/`，`@napuketto/adapter/milky` 子路径导出）：
  单端口 HTTP（`POST /api/:api` 规范信封 + 401/404/415 语义；`GET /event` SSE/WS）+
  WebHook 推送（HttpClient，Bearer 头）。类型层 = Milky 1.3 JSON Schema 的自研描述
  （P0 子集，SSOT 与版本写死文件头，未参考 GPL 实现）。
- **动作 9 个**：get_login_info / get_impl_info / send_private_message /
  send_group_message / get_message / recall_private_message / recall_group_message /
  get_friend_list / get_group_list。错误映射：-400 参数失败（规范）/-403 未登录（规范）/
  其余自定负数（error-map.ts）。
- **事件 2 个**：message_receive（三场景，实体 best-effort 回填）/ message_recall
  （grayTip REVOKE）。自消息不上报（固定）。
- **seq↔msgId**（§5 未决问题之二）：**adapter 侧方案（方案二）**——
  `MessageSeqIndex` 双向映射（接收链路登记，FIFO 4096 封顶），`get_message`/撤回
  反查未命中时扫近段历史兜底；kernel 不动。
- **装配**：loader `assemble-protocols`（段非空才装配）/ `load-config`（`milkySection`）/
  cli `config schema + template` / create 脚手架模板。
- **测试**：翻译层 10 例 + 动作链 7 例 + 传输集成 7 例（真端口：信封/404/415/401/
  SSE 推送/WS 升级）+ network 原语 7 例。

## 0.5 P1 落地面（2026-10-30）

- **动作 9 → 49 个**：资料/票据（get_user_profile / get_friend_info / set_avatar /
  set_nickname / set_bio / get_cookies / get_csrf_token）、好友操作（send_profile_like /
  delete_friend / get_friend_requests / accept/reject_friend_request）、消息
  （get_history_messages / get_forwarded_messages / mark_message_as_read）、群管
  （get_group_info / get_group_member_list / get_group_member_info / set_group_name /
  set_group_member_card / set_group_member_admin / set_group_member_mute /
  set_group_whole_mute / kick_group_member / quit_group）、精华与表态
  （get_group_essence_messages / set_group_essence_message /
  send_group_message_reaction）、通知（get_group_notifications /
  accept/reject_group_request / accept/reject_group_invitation）、群文件
  （get_group_files / move / rename / delete_group_file / persist_group_file /
  create_group_folder / delete_group_folder）。
- **事件 2 → 15 个**：friend_request / group_join_request / group_invited_join_request /
  group_invitation（通道系，Buddy/Group 事件通道）/ group_member_increase /
  group_member_decrease / group_mute / group_whole_mute / group_name_change /
  group_disband（grayTip 系，后两者操作者不可得时不产出）/ friend_nudge /
  group_nudge（aioOp，best-effort + raw 校准日志，与 OB11 poke 同口径）/
  group_file_upload（群场景文件消息替代 message_receive）。未接（无源，P2）：
  group_message_reaction / peer_pin_change / group_essence_message_change /
  bot_offline / friend_file_upload。
- **ID 模型补全**：合并转发 resId 索引（seqIndex 增 recordForward/resolveForward），
  接收段 forward_id 改为 resId（规范「转发消息 ID」语义），
  get_forwarded_messages 经索引定位 peer。
- **依赖扩充**：MilkyApi + profileLikeApi / ticketApi / webApi / groupNotifyApi /
  richMediaApi（loader services 透传）+ self.uid（get_friend_requests.target_user_uid）。
- **翻译共享收敛**：uid→uin 解析 / request 上下文 / BuddyReq 防御收窄 / grayTip
  未翻译提取器落 `adapter/src/core/`（OB11 / Milky 双方共用，克隆清零）。
- **测试**：notice 翻译 11 例 + request 翻译 7 例 + P1 动作 9 例 + seqIndex 转发 1 例
  （全仓 92 文件 / 883 例全绿；fallow 门禁 55 变更文件零问题）。

**延后（P2）**：forward 段发送 → 已在 P2 批次一落地（§0.6）。其余依赖实机探测：
rename_group_folder（kernel 无 renameFolder 出口）、get_group_file_download_url
（fileItem 无 url 字段）、get_resource_temp_url（resource_id 反查）、
send_friend_nudge / send_group_nudge（无 nudge 发送）、群公告 / 置顶 / 专属头衔 /
群头像 / 上传（kernel 无出口）。

## 0.6 P2 批次一（2026-10-31）：forward 发送段

发送段 9/10 → 10/10。规范语义（官方 OutgoingSegment / OutgoingForwardedMessage，
MIT）：forward 发送段 = `messages: {user_id, sender_name, time?, segments}[]`（任意
内容组装）+ 可选 title / preview / summary / prompt。

**实现（kernel 零改动，临时消息法）**：逐条临时发送 messages[i].segments →
`buildMultiForwardMsg` 组装（kernel `sendForwardMessage`，源 = 目标 peer）→ 发出 →
best-effort 撤回临时消息（失败记 warn，不影响转发已发出）。

**已知差异（待实机联调校准，同 #28 ARK 发送先例）**：

- 节点发送者恒为机器人自己（组装基于真实消息，user_id / sender_name / time 仅作
  schema 校验不参与组装；kernel 无伪造发送者出口）。
- title / preview / summary / prompt 忽略（buildMultiForwardMsg 无对应入参）。
- 临时消息在发送→撤回窗口内可见；其撤回产生 message_recall 广播（operator = 自己）。
- 约束：forward 段单独发（不混发、单次一个）；messages 为空 / 项内无可用段 /
  嵌套 forward → INVALID_PARAM。

**批次二（依赖实机探测产物，未开工）**：上表其余 9 个 API + 5 个无源事件
（group_message_reaction / peer_pin_change / group_essence_message_change /
bot_offline / friend_file_upload）。前置操作：宿主以 `NAPUTO_PROBE=1` 启动，产
`napuketto-probe.json`（+35s 晚探测 `napuketto-probe-late.json`）至 NAPUTO_CFG_DIR
（缺省 cwd）——产物含各 `get*Service` 完整方法面（kernel probe.ts
collectServiceGetters，已具备）；按方法面设计 kernel 出口（说明书参考 + 待探测校准
惯例），再接 adapter。

## 1. 为什么做

Milky 是针对 OneBot 11 的历史设计做的**重写**，不是扩展。对我们这种"kernel 已经是
语义化 API"的实现，它反而比 OB11 更贴合：

| 维度 | OneBot 11 | Milky | 对本仓的意义 |
|---|---|---|---|
| 消息表示 | CQ 码 + 消息段双形态 | 只有消息段 | 删掉 CQ 编解码与转义整层 |
| 会话模型 | `message_type` + `sub_type` 组合 | `message_scene` 三值（friend/group/temp） | 删掉组合爆炸的翻译分支 |
| 消息 ID | 实现方伪造 int32 | 原生 `message_seq` | 不再需要伪造的 int32 空间（仍有 seq→msgId 反查，见 §5） |
| 错误语义 | `retcode` 无规范（0 / 1xx 惯例） | `0` / `-400` / `-403` / 自定 + HTTP 401/404/415 | 少一层错误映射表 |
| 版本协商 | 无 | `get_impl_info` 带 `milky_version` | 客户端可自行判断兼容性 |
| 规范形态 | 散落的 Markdown，冻结 | OpenAPI 3.1 + JSON Schema + IR（可生成代码） | 类型层零手写，可机读校验 |

结论：**做 Milky 的边际成本低于 OB11**，因为它天然对齐 kernel 的语义，不需要为协议缺陷打补丁。
真正的成本瓶颈在 kernel 能力（见 §6 的 ❌ 项），不在协议层。

## 2. 版本与兼容性（已核实）

| 版本 | 发布日 | 备注 |
|---|---|---|
| 1.0.0 | 1.1.0 之前 | 首个正式版 |
| 1.1.0 | 2026-01-09 | rc.1–rc.6 预发布期约 1 个月 |
| 1.2.0 | 2026-04-06 | 首次把"应用端兼容要求"写进规范 |
| 1.3.0 | 2026-08-07 | 当前线 |

兼容性契约（[官方 兼容性 页](https://milky.ntqqrev.org/guide/compatibility)）：

- SemVer；每季度一个 Minor「累积更新」，周期约 3 个月（前 2 个月收 FR，最后 1 个月只评议）。
- 跨 Minor **不重命名、不删除、不改语义**；无 Major 计划。
- **协议端向后兼容、应用端向前兼容**：旧应用端必须能连新协议端，反之不保证。
- 联合会话只增子类型；1.2 起要求应用端对未知子类型容错（未知消息段 → `text`，数组中
  未知项 → 跳过，单个未知 → 可抛错）。

对我们做**协议端**的含义：只要"只增不改"，升级不会破坏已发布的客户端。这条比 OB11（零
版本概念）强，也比 Satori（无版本协商）稳。

## 3. 许可证边界（硬约束）

| 资产 | 许可证 | 可用性 |
|---|---|---|
| 规范正文 / OpenAPI / JSON Schema / Milky IR | MIT | ✅ 可直接使用 |
| `@saltify/milky-protocol@1.3.0`（IR + TS 导出，零依赖） | MIT | ✅ 建议作 devDependency |
| `milkygen`（代码生成 CLI） | MIT | ✅ 生成 TS / Zod 类型 |
| Lagrange.Milky | GPL-3.0 | ❌ 禁止参考实现代码 |
| Yogurt | GPL-3.0 | ❌ 禁止参考实现代码 |
| LuckyLilliaBot (LLBot) | **GPL-2.0** | ❌ 禁止任何形式移植（ADR-001 红线） |

规则：**只用规范与生成产物，不读三家实现的源码。**行为对齐靠"发请求看响应"的黑盒
对照（LLBot 部署一份即可），不靠读代码——这既是许可证要求，也避免把它们的架构带进来。

## 4. 传输层

Milky 协议端必须提供 HTTP 服务，两个端点：

| 端点 | 方法 | 用途 |
|---|---|---|
| `/api/:api` | POST（JSON body） | API 调用；无参数也必须传 `{}` |
| `/event` | GET | 事件推送：按 `Upgrade: websocket` 头分流 WS，否则 SSE |

另外支持**多地址 WebHook 主动推送**（POST，body 与 WS 推送同构）。

**鉴权**：`Authorization: Bearer <access_token>`；SSE / WS 在不支持自定义头的环境下允许
`?access_token=` 查询参数（WebHook 方向由协议端在**请求头**发 token，应用端校验）。

**响应约定**：

| 情况 | HTTP 状态 | body |
|---|---|---|
| 成功 | 200 | `{ status: "ok", retcode: 0, data }` |
| 参数解析失败 | 200 | `{ status: "failed", retcode: -400, message }` |
| 未登录 | 200 | `{ status: "failed", retcode: -403, message }` |
| 其他业务错误 | 200 | `{ status: "failed", retcode: <自定负数>, message }` |
| 鉴权失败 | 401 | — |
| API 不存在 | 404 | — |
| Content-Type 不支持 | 415 | — |

**与 `@napuketto/network` 的映射**：

- `/api` 复用 `HttpServer`（hono）已有能力：路由 + JSON 解析 + Bearer/query token 鉴权
  （OB11 传输层已有同款，逻辑可抽出复用）。
- 事件推送复用 `EventBroadcaster`（多订阅者广播）。
- `/event` 的 WS 分支复用 `WsServer`。
- **缺口：SSE 原语**。`network` 目前没有 SSE。SSE 是纯 HTTP 语义（`text/event-stream` +
  `data:` 行 + 空行结尾），**可以下沉 `network`**，不违反 ADR-002 的"协议无关"——
  与 ADR-021（KuroBot 的子协议/应用层心跳属协议语义，故在 adapter 自建）不同。

配置形态（`[accounts.milky]`，与现有协议段同构）：

```toml
[accounts.milky]
enabled = true            # 无此段 = 不启用
host = "127.0.0.1"
port = 3001
token = ""                # access_token，空 = 不校验（仅限内网）
eventModes = ["sse", "ws"]  # /event 允许的连接形态
webhooks = []             # 额外事件推送地址，可多个
```

## 5. 数据模型与 ID

**规模**（来自 JSON Schema，105 个结构定义）：

- 事件：`Event` 联合会话，**21 种** `event_type`。
- 接收消息段：**14 种**（text / mention / mention_all / face / reply / image / record /
  video / file / forward / market_face / light_app / xml / markdown）。
- 发送消息段：**10 种**（text / mention / mention_all / face / reply / image / record /
  video / forward / light_app）：不含 file、market_face、xml、markdown；`forward` 用
  `messages[]` 内嵌而非 `forward_id`。
- `message_scene`：`friend` / `group` / `temp`。

**ID 模型**（关键差异点）：

| 概念 | Milky | 本仓现状 |
|---|---|---|
| 用户 | `user_id` = uin；请求里 `initiator_uid` 等用 uid | kernel 有 `uinToUid` / `uidToUin`，但**返回给协议的必须是 uin** |
| 消息 | `message_seq`（会话内序列号） | kernel 实体有 `msgSeq`，但撤回/取消息入口是 `msgId` |
| 资源 | `resource_id` + `temp_url` | 图片/语音/视频元素带 URL，无 resource_id 抽象 |
| 合并转发 | `forward_id` | `fetchForwardMessage` 已能按 id 取 |
| 群通知 | `notification_seq` | `getSingleScreenNotifies` 的 seq，OB11 已用 `item.seq` 作 flag |

**待解决**：`message_seq → msgId` 的反查。方案二选一（实现时定）：

1. kernel 新增按 `(peer, msgSeq)` 反查 `msgId` 的索引（推荐：协议无关，Milky 与未来协议共用）；
2. adapter 侧维护薄映射（现状 OB11 的 `MessageUnique` 方向相反，可复用其结构）。

⚠️ 不要因为"Milky 用原生 seq"就认为能省掉映射——NT 的撤回/查询仍要 `msgId`，这层跳不掉。

## 6. 接口覆盖（65 个 → kernel 现状）

图例：✅ kernel 已有且语义匹配 ／ 🟡 需薄包装或映射 ／ ❌ kernel 无此能力（需探测 wrapper）

### 系统（17）

| API | 状态 | kernel 对应 / 缺口 |
|---|---|---|
| `get_login_info` | ✅ | `services.self`（OB11 同名动作已有） |
| `get_impl_info` | 🟡 | `NAPUTO_QQ_VERSION` + 包版本；`qq_protocol_type` 固定 `windows`，`milky_version` 写 `"1.3"` |
| `get_user_profile` | 🟡 | `ProfileApi.getStrangerInfo` + 好友缓存 |
| `get_friend_list` | ✅ | `FriendApi.getFriendList` |
| `get_friend_info` | ✅ | 同上（缓存单查） |
| `get_group_list` | ✅ | `GroupApi.getGroupList` |
| `get_group_info` | ✅ | `GroupApi.getGroupInfo` |
| `get_group_member_list` | ✅ | `GroupApi.getGroupMemberList` |
| `get_group_member_info` | ✅ | `GroupApi.getGroupMemberInfo` |
| `get_peer_pins` | ❌ | 无置顶能力 |
| `set_peer_pin` | ❌ | 同上 |
| `set_avatar` | ✅ | `ProfileApi.setHeader` |
| `set_nickname` | ✅ | `ProfileApi.setNickName` |
| `set_bio` | ✅ | `ProfileApi.setLongNick` |
| `get_custom_face_url_list` | ❌ | 无收藏表情接口 |
| `get_cookies` | ✅ | `TicketApi.getCookies` |
| `get_csrf_token` | ✅ | `TicketApi.getClientKey` |

### 消息（9）

| API | 状态 | kernel 对应 / 缺口 |
|---|---|---|
| `send_private_message` | ✅ | `MsgApi.sendMessage` |
| `send_group_message` | ✅ | 同上 |
| `recall_private_message` | ✅ | `MsgApi.recallMessage` |
| `recall_group_message` | ✅ | 同上 |
| `get_message` | 🟡 | `MsgApi.fetchMsgsByMsgId`，需 seq→msgId（§5） |
| `get_history_messages` | ✅ | `MsgApi.fetchMessages` |
| `get_resource_temp_url` | 🟡 | 接收段自带 `temp_url`；`resource_id` 反查待确认 |
| `get_forwarded_messages` | ✅ | `MsgApi.fetchForwardMessage` |
| `mark_message_as_read` | ✅ | `MsgApi.markRead` |

### 好友（6）

| API | 状态 | kernel 对应 / 缺口 |
|---|---|---|
| `send_friend_nudge` | ❌ | 无 nudge 发送（OB11 侧 poke 也只做通知，未做发送） |
| `send_profile_like` | ✅ | `ProfileLikeApi.sendLike` |
| `delete_friend` | ✅ | `FriendApi.deleteFriend` |
| `get_friend_requests` | ✅ | `FriendApi.getBuddyReqList` |
| `accept_friend_request` | ✅ | `FriendApi.handleFriendRequest` |
| `reject_friend_request` | ✅ | 同上 |

### 群（21）

| API | 状态 | kernel 对应 / 缺口 |
|---|---|---|
| `set_group_name` | ✅ | `GroupApi.modifyGroupName` |
| `set_group_avatar` | ❌ | 无群头像接口 |
| `set_group_member_card` | ✅ | `GroupApi.setMemberCardName` |
| `set_group_member_special_title` | ❌ | 无专属头衔接口 |
| `set_group_member_admin` | ✅ | `GroupApi.setMemberRole` |
| `set_group_member_mute` | ✅ | `GroupApi.setMemberShutUp` |
| `set_group_whole_mute` | ✅ | `GroupApi.setGroupShutUp` |
| `kick_group_member` | ✅ | `GroupApi.kickMember` |
| `get_group_announcements` | ❌ | 无群公告 |
| `send_group_announcement` | ❌ | 同上 |
| `delete_group_announcement` | ❌ | 同上 |
| `get_group_essence_messages` | ✅ | `WebApi.getEssenceMsgList` |
| `set_group_essence_message` | ✅ | `GroupApi.addGroupEssence` / `removeGroupEssence` |
| `quit_group` | ✅ | `GroupApi.quitGroup` |
| `send_group_message_reaction` | ✅ | `MsgApi.setMsgEmojiLike`（OB11 `set_msg_emoji_like`） |
| `send_group_nudge` | ❌ | 无 nudge 发送 |
| `get_group_notifications` | ✅ | `GroupNotifyApi.getSingleScreenNotifies` |
| `accept_group_request` | ✅ | `GroupNotifyApi.handleGroupRequest` |
| `reject_group_request` | ✅ | 同上 |
| `accept_group_invitation` | ✅ | 同上（通知类型区分） |
| `reject_group_invitation` | ✅ | 同上 |

### 群文件（12）

| API | 状态 | kernel 对应 / 缺口 |
|---|---|---|
| `upload_private_file` | ❌ | 无上传（OB11 也没有） |
| `upload_group_file` | ❌ | 同上 |
| `get_private_file_download_url` | ❌ | 无私聊文件下载链接 |
| `get_group_file_download_url` | 🟡 | `RichMediaApi.getGroupFileList` 内的 url 字段，待确认 |
| `get_group_files` | ✅ | `RichMediaApi.getGroupFileList` |
| `move_group_file` | ✅ | `RichMediaApi.moveGroupFile` |
| `rename_group_file` | ✅ | `RichMediaApi.renameGroupFile` |
| `delete_group_file` | ✅ | `RichMediaApi.deleteGroupFile` |
| `persist_group_file` | 🟡 | `RichMediaApi.transGroupFile`（转存语义待对齐） |
| `create_group_folder` | ✅ | `RichMediaApi.createGroupFolder` |
| `rename_group_folder` | ✅ | 同上 |
| `delete_group_folder` | ✅ | `RichMediaApi.deleteGroupFolder` |

**合计：✅ 46 ／ 🟡 6 ／ ❌ 13。** 46 个可以直接映射，协议层工作量主要是编解码；
13 个 ❌ 全部要先探测 `wrapper.node` 有没有对应 native API——这是本项目最大的不确定性，
也是 P2 之前不该对外承诺的面。

## 7. 事件覆盖（21 个 → kernel 数据源）

| `event_type` | 数据源 | 状态 |
|---|---|---|
| `message_receive` | `Msg/onRecvMsg` | ✅ 已接 |
| `message_recall` | grayTip REVOKE | ✅ 已接（OB11 `group_recall` / `friend_recall`） |
| `friend_request` | `Buddy/onBuddyReqChange` | ✅ 已接 |
| `group_join_request` | `Group/onGroupNotifiesUpdated` | ✅ 已接 |
| `group_invited_join_request` | 同上 | ✅ 已接 |
| `group_invitation` | 同上（邀请自身入群） | 🟡 复用同源，需区分 |
| `group_member_increase` | grayTip | ✅ 已接 |
| `group_member_decrease` | grayTip | ✅ 已接 |
| `group_mute` | grayTip | ✅ 已接 |
| `group_whole_mute` | grayTip | ✅ 已接 |
| `friend_nudge` | grayTip `aioOp` | 🟡 OB11 侧仍"待真实事件校准" |
| `group_nudge` | 同上 | 🟡 同上 |
| `friend_file_upload` | `Msg/onRecvOfflineFileMsg` | 🟡 payload 形状未定 |
| `group_file_upload` | 群消息 file 元素 / `onRecvOnlineFileMsg` | 🟡 |
| `group_essence_message_change` | `Group/onGroupEssenceListChange` | 🟡 目前只打原始日志 |
| `group_admin_change` | sysmsg protobuf | ❌ 识别表为空 |
| `group_name_change` | sysmsg protobuf | ❌ 同上 |
| `group_message_reaction` | 无推送回调 | ❌ |
| `group_disband` | 无源 | ❌ |
| `peer_pin_change` | 无源 | ❌ |
| `bot_offline` | kernel 登录生命周期 | 🟡 需确认离线/掉线事件 |

**结论**：21 个里 9 个可直接复用 OB11 已打通的链路，7 个是"同源但需补翻译"，5 个无源。
事件侧的成本主要落在 sysmsg 识别表（OB11 的历史欠账，Milky 同样受益）。

## 8. 装配接缝（改动清单）

新增协议只需碰这些位置，不改 kernel、不改 network（除了 SSE 原语）：

| 文件 | 改动 |
|---|---|
| `packages/adapter/src/milky/` | 新目录：`adapter.ts`（继承 `BaseProtocolAdapter`）、`config.ts`（zod schema）、`action/`、`event/`、`transport.ts`、`types/`（codegen 产物） |
| `packages/adapter/package.json` | `exports` 加 `./milky`（tsdown 以 exports 为入口，无需额外配置） |
| `packages/adapter/src/index.ts` | 根入口保持轻量，不 re-export milky |
| `packages/adapter/docs/design.md` | 实现前先补设计（项目约定：设计先行） |
| `packages/loader/src/host/core/assemble-protocols.ts` | 动态 import `milky/index.mjs` + `ProtocolConfig` + 构造 + start/stop |
| `packages/loader/src/host/load-config.ts` | `ProtocolKey` 加 `"milky"`，`loadProtocolSections` 返回 `milkySection` |
| `apps/cli/src/config/schema.ts` | 账号段 schema 加 `milky?`，`parseProtocolSection` 分支 |
| `apps/cli/src/config/template.ts` | 配置模板注释加 `[accounts.milky]` |
| `apps/napuketto-create/templates/napuketto.toml.tmpl` | 脚手架模板同步该段（与 cli 模板一起改） |
| `packages/network/src/` | 新增 SSE 原语（协议无关），`http-server` 支持 `text/event-stream` |
| `docs/protocols/milky.md` / `docs/README.md` / `docs/guides/configuration.md` | 文档同步 |

## 9. 实施顺序

### P0（骨架，能连通、能收发一条消息）——已落地（2026-10-28）

1. [x] `network` 加 SSE 原语 + 单测（另含 `HttpServer` 流式响应/同端口 WS 升级注入点）。
2. [x] `packages/adapter/src/milky/`：配置 schema、HTTP server（`/api` + 鉴权 + 错误映射）、
   `/event`（SSE 与 WS 同端口并存）。
3. [x] 类型层：P0 子集**手写自研描述**（SSOT = 官方 JSON Schema，MIT；未走
   `@saltify/milky-protocol` + `milkygen` 依赖/生成链，P1 扩面时再评估切换）。
4. [x] 接口：`get_login_info`、`get_impl_info`、`send_private_message`、`send_group_message`、
   `get_message`、`recall_*`、`get_friend_list`、`get_group_list`。
5. [x] 事件：`message_receive`、`message_recall`。
6. [x] 装配接缝 + 配置模板 + 文档。

验收（本仓侧）：单测/集成全绿；`koishi-plugin-adapter-milky` 实机连通属独立仓库，
待宿主联调。

### P1（可用面）——已落地（2026-10-30，见 §0.5）

1. [x] 接口扩面：✅ 46 中可落地的 40 个（群管 / 精华 / 群文件 / 好友请求 / 票据 /
   资料）+ 🟡 get_user_profile / persist_group_file——动作面 9 → 49；
   rename_group_folder / get_group_file_download_url / get_resource_temp_url /
   nudge 发送 kernel 无出口，转 P2。
2. [x] 事件扩面：2 → 15（通道系请求 4 + grayTip 系 10 + 群文件上传）；
   group_essence_message_change / bot_offline / friend_file_upload 源待校准，转 P2。
3. [x] 消息段：接收 12/14（market_face / markdown 原始元素形状未探测，canonical
   unknown 跳过）；发送 9/10 → **10/10**（forward 段 P2 批次一落地，§0.6，临时消息法）。
4. [x] `message_seq → msgId` 索引定型（P0 方案二 adapter 侧 MessageSeqIndex，
   P1 补转发 resId 索引）。

验收：Koishi 端跑通常规 bot 流程（待实机联调）；OB11 与 Milky 同账号并行不互斥
（多协议各自传输，共用 kernel 服务）。

### P2（长尾，依赖 native 探测）

- [x] 批次一（2026-10-31）：forward 发送段（§0.6，临时消息法 + 已知差异）。
- [ ] 批次二：13 个 ❌ 里可实现的（群公告、置顶、nudge、上传、私聊文件下载、收藏表情、
  群头像、专属头衔）——前置 `NAPUTO_PROBE=1` 实机探测（§0.6 runbook），按方法面设计
  kernel 出口后接 adapter。
- [ ] 5 个无源事件（sysmsg 系 2 个 + reaction / disband / pin）：先补 sysmsg 识别表与
  回调探测，再谈翻译。

## 10. 验收与测试

| 层 | 手段 |
|---|---|
| 类型/结构 | 用官方 JSON Schema 做契约测试：我方输出必须通过 schema 校验 |
| 翻译纯函数 | vitest 单测（ADR-008：翻译是纯函数，可脱离 QQ 跑） |
| 端到端 | `koishi-plugin-adapter-milky` 实机；`nonebot-adapter-milky` 抽测 |
| 对照 | 同动作在 LLBot 与本实现的响应结构对齐（黑盒，不读源码） |
| 回归 | 每个 P 阶段在 `docs/protocols/milky.md` 勾掉对应项 |

补充：官方 [Roadmap](https://milky.ntqqrev.org/raw/markdown/roadmap.txt) 是一份 65 项
checkbox 的实现清单，可直接作为进度表（下载到本地或按其分组维护）。

## 11. 未决问题

1. **SSE 原语归属**：下沉 `network`（倾向）还是 adapter 自建？下沉更合理，但要让 `HttpServer`
   支持流式响应，需确认 hono 版本能力。
2. **seq→msgId**：kernel 加索引 vs adapter 自建。前者一次投入多协议受益，后者更快但重复。
3. **13 个 ❌ 的可行性**：群公告/置顶/nudge/上传是否在 `wrapper.node` 有出口，必须先跑探测
   （`packages/kernel/src/wrapper/probe/`），结论决定 P2 是否砍范围。
4. **版本跟踪策略**：锁 1.3.0 实现；1.4.0 预计 2026-11~12（节奏见 §2）。跟随策略 = 只在
   rc 期更新 codegen，正式版后再发我们的 patch。
5. **temp 会话**：Milky 的 `temp` 场景在 NT 侧对应临时会话，OB11 是 `sub_type=group`；
   kernel 现有 peer 解析需确认覆盖。
6. **`get_impl_info.qq_protocol_version`**：从 `env.NAPUTO_QQ_VERSION` 取，语义是"QQ 客户端
   版本"，与 `impl_version`（我们的包版本）要分清。
7. **多账号**：Milky 是 `/api` 单端口模型，单进程一账号（ADR-015）不变；同账号多协议共存
   沿用 Satori 的"共用 kernel 服务、各自传输"模式。

## 12. 参考

- 规范站：<https://milky.ntqqrev.org/>
- 兼容性与发布节奏：<https://milky.ntqqrev.org/guide/compatibility>
- 通信层：<https://milky.ntqqrev.org/guide/communication>
- 仓库：<https://github.com/SaltifyDev/milky>
- 实现清单（Awesome）：<https://milky.ntqqrev.org/awesome>
- 机读规范：`/raw/openapi/openapi.json`、`/raw/json-schema/schema.json`、
  `/raw/milky-ir/ir.json`、`/raw/markdown/roadmap.txt`
- npm：`@saltify/milky-protocol`（MIT，IR + TS）、`milkygen`（MIT，代码生成）
