# @napuketto/adapter 设计书（2026-09-08 首版：覆盖 onebot11 事件链 / onReload / get-media / satori 媒体；2026-10-28 增 milky P0）

> 协议适配器容器（ADR-013）：core 框架（BaseProtocolAdapter/ActionRegistry/
> ProtocolConfig）+ onebot11 + satori。只认识 kernel 的 API/事件/缓存，不认识
> 原生（红线）。本文覆盖 2026-09-08 接线轮次动到的模块；79 动作注册表 /
> CQ 码 / 传输装配等既有结构见源码与 `docs/architecture/overview.md`。

## 1. onebot11 事件链（adapter.ts 订阅 + helper/ 翻译）

```
kernel 通道                          adapter 订阅                    翻译（纯函数）          → broadcaster
Msg/onRecvMsg                    →  subscribe()                 →  message-event / notice    → OB11 事件
Group/onGroupNotifiesUpdated     →  subscribe()（2026-09-08）    →  request.ts               → request 事件（group_add/invite）
Buddy/onBuddyReqChange           →  subscribe()（2026-09-08）    →  request.ts               → request 事件（friend）
Buddy/onBuddyListChange(dV2)     →  subscribe()（2026-09-08）    →  仅 raw 校准日志（形状未知，不翻译）
Msg/onRecvOfflineFileMsg         →  subscribe()（c3，2026-09-10）→  notice-extra.ts          → offline_file notice
Msg/onRecvSysMsg                 →  subscribe()（c3，2026-09-10）→  sysmsg.ts（§7 解码，识别表空=仅校准日志）
Msg/onRecvOnlineFileMsg          →  subscribe()（c3，2026-09-10）→  仅 raw 校准日志（OB11 无对应类型）
Group/onGroupEssenceListChange   →  subscribe()（c3，2026-09-10）→  仅 raw 校准日志（group_essence 候选源）
```

- **request 事件**（`helper/request.ts`）：
  - GroupNotify → group request：type 1/5=invite、7=add（与 get_group_system_msg
    动作同一解释）；仅未处理状态（KUNHANDLE）推送；flag = seq（与
    set_group_add_request 的 `item.seq === flag` 匹配路径一致）。
  - BuddyReq → friend request：`narrowBuddyReqs` 防御性收窄（`BuddyReq[]` /
    `{buddyReqs}`；未知形状打 raw 日志）；flag = reqTime；comment 取 words
    字段（形状待校准）。
  - doubt 可疑群通知跳过（与 set_group_add_request 的先非可疑后可疑匹配序一致）。
- **notice 补全**（`helper/notice.ts`，2026-09-08）：
  - friend_recall：C2C grayTip REVOKE。
  - notify.poke：aioOpGrayTipElement——**待真实事件验证**（口径：user_id=发送者，
    target_id=aioOp.peerUid，group_id=群号/C2C 0；poke 路径始终打 raw 日志）。
    **手动触发指引（校准用）**：需另一个 QQ 号在群里/私聊戳机器人账号
    （手机 QQ「戳一戳」或群内双击头像戳一戳），产生的 aioOp grayTip 会打
    `ob11: poke grayTip raw（待真实事件校准）` raw 日志——日志去向：
    IPC 模式（koishi）落 `<cfgDir>/logs/loader.log`；cli 模式仅 console
    （boot 转发终端输出）。拿到 raw 后校准 toPoke 的 user_id/target_id/
    group_id 口径并移除「待验证」标注。
  - friend_add（B2，2026-09-08）：数据源 = kernel `BuddyCache` 快照 diff
    （`Buddy/onBuddyListChange` 全量快照，T10 实证 = BuddyCategory[]，
    明细在 category.buddyList；首帧只建 baseline 不发事件）→
    `BuddyCache/onBuddyAdded` → `toFriendAdd`（user_id = coreInfo.uin）。
    diff/baseline 在 kernel 缓存层，adapter 翻译纯函数；onBuddyRemoved
    仅维护缓存（OB11 无 friend_remove 通知类型，不翻译）。
  - group_upload（B4，2026-09-08）：配置开关 `groupUploadAsNotice`
    （默认 false）。false = message 事件 + **file 段透出**（go-cqhttp 兼容；
    代码考古发现此前 file 元素被静默丢弃——转换表无 file 键，本版本起补齐，
    属修复而非行为变更）；true = 含 fileElement 的群消息改报 group_upload
    notice（user_id + file{id=fileUuid, name, size, busid=102}）替代
    message 事件。onRecvMsg 分支判定在 adapter.ts（grayTip → 文件开关 →
    reportSelfMessage → message）。
  - 未知/未翻译 grayTip 子类型（JSON/BUDDY/ESSENCE/GROUP_NOTIFY/FILE 等）打
    raw JSON 校准日志（lucky_notify / honor / essence 翻译的
    数据源积累入口）。
- **校准 logger**：`OneBot11AdapterOptions.logger`（warn/info 最小面），
  装配方传 pino 实例；缺省静默。
- **sender.role 群缓存判定（2026-10-28）**：群消息事件与 get_msg/历史消息的
  `sender.role` 经 `OneBotApi.groupMemberRole(s)` 查 kernel `GroupCache`
  （缓存优先，缺失惰性回填整表/单查）判定 owner/admin；查询失败或未装配缓存
  回退缺省 `"member"`，不阻塞上报。角色经 `ReceiveTranslateContext.senderRole`
  注入，翻译层保持纯函数（ADR-008）。
- **c3 扩展源（2026-09-10，`helper/notice-extra.ts`）**：五无源事件探测轮产物
  （证据矩阵见 kernel design.md §1「c3 新接线」）：
  - **offline_file**：源 = kernel `Msg/onRecvOfflineFileMsg`（字符串簇 + RTTI
    强证据）。翻译 = `narrowOfflineFiles` 防御性收窄（RawMessage 型
    elements[].fileElement / 专用实体型 fileName 顶层或 fileInfo 嵌套；未知
    形状返回 null 打 raw 日志）→ `toOfflineFileNotice`（user_id + file
    {name, size, url}）。payload 真实形状待校准——收窄口径固化在单测，
    校准后回填。
  - **group_card / group_title / group_sign**：载体 = `Msg/onRecvSysMsg`
    （sys msg 总闸，运行时实触，payload = **原始 protobuf 字节**）。当前仅
    raw 校准日志；protobuf 解码 + type/subType → notice 映射是下轮工作。
  - **msg_emoji_like**：无推送回调（API 面 getMsgEmojiLikesList 存在），
    无源可接，待观测（疑经 onMsgInfoListUpdate）。
  - **group_essence（清单外）**：`Group/onGroupEssenceListChange` raw 校准
    日志（精华事件的候选直达源，与 grayTip ESSENCE 子类型双路积累）。
- **gap 清单**（源事件缺失或改报形式有风险，未翻译）：group_upload（文件消息
  现以 message 事件 + file 段透出，改 notice 影响现网 koishi 收向，待拍板）、
  group_card / group_title / group_sign（解码器已上线 §7，识别表待真实样本
  校准）、msg_emoji_like（无推送源）、offline_file（已翻译，payload
  待真实事件校准）、friend_add（源存在但 payload 未知，raw 日志积累中）。

## 2. onReload 热更新（2026-09-08 实现，P2-6 兑现）

`BaseProtocolAdapter.reload()` = `config.reload()`（重读文件）→ `onReload(config)`：

- **onebot11**：`reloadTransports`——stopAll（心跳/退订/传输关闭）→
  startTransports（新配置装配 + lifecycle enable + 心跳）。
  **IPC 桥模式**（subscribeOnly，subscribedOnly 标记）无传输不重建，仅刷新
  reportSelfMessage / messagePostFormat。
- **satori**：stopAll（广播 login-updated 离线）→ startTransports（新配置装配，
  广播在线）。无 IPC 桥模式，恒走重建。

## 3. get_image / get_record（action/message/get-media.ts，2026-09-08 接主动下载；B1 语音原生下载）

- **本地解析**：NT 相对路径（sourcePath/filePath）按 `mediaBaseDir`（QQ NT
  global 目录）解析绝对路径，磁盘命中即返回 file。mediaBaseDir 由装配方
  （loader assemble-protocols / ipc-ob11）经 `resolveQqUserDataRoot` +
  `resolveQqGlobalPath` 从 wrapper util 解析注入（失败缺省——仅 URL 下载路径）。
- **图片主动下载**：本地未命中且有 picUrl → `@napuketto/media downloadUrl`
  落 `cacheDir/media/`，返回 file（绝对路径）+ url + file_size/file_name；
  失败回退 url-only（不抛错）。
- **语音主动下载（B1，2026-09-08）**：本地未命中 → kernel
  `MsgApi.downloadPtt`（原生 `msgService.downloadRichMedia` 单参对象
  {msgId, elemId, chatType, downloadType:2, thumbSize:0} → 轮询
  getMsgsByMsgId 等 filePath/transferStatus 就绪，约 10s 超时）→ 落盘后
  返回 file 绝对路径；下载失败回退现状（原始 filePath + 元数据，不抛错）。
  实测注意：transferStatus=2（数据库已下载态）时原生调用为 no-op——磁盘
  缺失场景无法经此恢复（详见 kernel design.md §5）。

## 4. satori 媒体（helper/element/media-convert.ts）

- video 非 mp4 输入 → `@napuketto/media transcodeVideo`（ffmpeg H.264 归一化，
  exitCode/产物校验）→ 失败/缺 ffmpeg fail-soft 原样透传。mp4 直通不转码。
- audio 已有 ensureSilk（非 silk 转码）不变。

## 5. media 包依赖面（ADR-011）

adapter 依赖 `@napuketto/media`（encodePcmToSilk / decodeSilkToWav /
transcodeVideo / downloadUrl / inferExtension）。kernel 不依赖 media。

## 6. 已知缺口（2026-09-10 c3 轮后）

- poke 翻译字段校准（首次真实事件后；手动触发指引见 §1）。
- **onRecvSysMsg 识别表校准**（解码器已上线 = §7；group_card / group_title /
  group_sign 的 (msgType, subType) 判别值无样本支撑，识别表为空 = 不广播，
  等真实样本登记规则）。
- onRecvOfflineFileMsg payload 形状校准（翻译已上线，收窄口径待真实事件修正）。
- onGroupEssenceListChange payload 形状（group_essence 翻译待校准）。
- onBuddyReqChange payload 形状（BuddyReq 字段 words 等待真实事件校准）。
- msg_emoji_like 无推送源（疑经 onMsgInfoListUpdate 或轮询，待观测）。

## 7. Msg/onRecvSysMsg protobuf 解码（2026-09-10，`helper/sysmsg.ts`）

### 7.1 样本清单与证据边界

- **真实样本 = 2 条**（c3 接线以来 onRecvSysMsg 全部实触），来源
  `$TEMP/napuketto-probe/notice-sources.json` 观测窗（2026-09-09T16:32Z 起）
  event-tally 步骤 `candidateSamples["Msg/onRecvSysMsg"]`；koishi-dev 全部
  28 个日志文件 grep 0 命中（观测窗外未再实触，子会话全量复核过）。
- 两样本均 **151 字节**、同一类型（msgType=528 / subType=382，见 7.3），
  **都不是 card/title/sign**——因此识别表（7.5）为空：目前没有任何
  (msgType, subType) → 事件种类的映射有样本支撑。fixture 入库前脱敏
  （等长字节替换 uin/uid/群码/base64 尾部；528/382/时间戳/varint 边界等
  结构字节保留原样，见 sysmsg.test.ts 头注释）。
- **wrapper.node 二进制分类学**（strings 扫描，同 probe 目录
  strings-ascii.txt）：56 个 `OnSysMsg*` 处理器。与 card/title 相关者 =
  `OnSysMsgModifyGroupMemberInfo`（名片）、
  `OnSysMsgModifyGroupMemberSpecialTitle`（个体头衔）、
  `OnSysMsgGroupLevelTitleChange`（等级头衔）；**无 sign 处理器 →
  group_sign 疑似不走 sysmsg 载体**（OB11 group_sign 保留表项，预期无源）。
- **原生日志格式**（strings 同页）：`OnRecvSysMsg msg_type=0x{:x}
  sub_type=0x{:x} is_online={}` 与 `Dispatcher sys msg cmd={} msg_type=…
  sub_type=… size={}`——原生分发键 = (msgType, subType)，是识别表的主键依据。

### 7.2 回调参数形状（实测）

`onRecvSysMsg(arg)` 的 arg = **带符号字节数组的数组**（djinni int8 透传，
JSON 序列化形如 `[[10,64,…]]`）：外层数组 = 批（两样本均单元素），内层 =
单条 sysmsg 的 protobuf 字节。`narrowSysMsgBlobs` 防御性收窄：接受批数组 /
单块裸数组 / TypedArray，逐项 `& 0xFF` 归一 Uint8Array；零有效块 → null
（调用方打 raw 日志，与 narrowOfflineFiles 同模式）。

### 7.3 字节布局（字段号依据 = 两样本观察，非任何第三方实现）

顶层消息三字段（两样本一致）：

| 字段 | 线型 | 观测内容 | 语义置信度 |
|---|---|---|---|
| f1 | msg(64) | `{f1: uin, f2: uid, f5: uin, f6: uid}` | 行为人/对象对；两样本两组相等（自身事件），f5/f6 语义待校准 |
| f2.f1 | varint | 528 | msgType（分发键；样本值，非 card/title/sign） |
| f2.f2 / f2.f3 | varint | 382 / 382 | subType（两字段观测恒等，subTypeAlt 备用） |
| f2.f4 / f2.f5 | varint | 群标识对（观测恒相邻整数，如 0xAAAAAAAA 与 +1） | 群相关标识；两值语义待校准（疑 code/uin 双记法） |
| f2.f6 | varint | 1788971533（= 2026-09-09T16:32:13Z，与观测窗吻合） | 事件时间戳（秒），高置信 |
| f2.f12 | varint | `2^57 \| f4`（高 25 位恒 0x2000000） | 群标识重记（64 位），低置信 |
| f2.f32 | varint | 64 位随机值 | 疑 msgRand，低置信 |
| f3 | msg(32) | `{f1: 空 bytes, f2: base64 串(28 字符)}` | 不透明载荷；base64 内容非 protobuf（try-parse 失败即按字节透传） |

### 7.4 解码器（`decodeProtoTree`，手写 wire-format，零依赖）

- 支持 varint（wire 0，BigInt 累积保 64 位精度）与 length-delimited
  （wire 2，递归 try-parse：子解析成功 → 嵌套树，失败 → 不透明 bytes）；
  wire 1/5 定长跳过（8/4 字节），wire 3/4 → 整块判失败。
- 防线上限：深度 16、每层 256 字段、varint ≤ 10 字节；截断 / field 0 → null。
- 树节点 = 判别联合 `{no, kind:"varint", value: bigint} | {no, kind:"bytes",
  value: Uint8Array, children: SysMsgField[] | null}`（children=null =
  不透明）。try-parse 为启发式，ASCII 串偶发误判嵌套无实害（树仅用于观测
  与未来白名单规则，不做无依据广播）。

### 7.5 识别与降级策略（不得猜错还硬广播）

- `recognizeSysMsg(msgType, subType, table = KIND_TABLE)`：查
  `"${msgType}:${subType}"` 主键。**KIND_TABLE 当前为空**——card/title/sign
  判别值无样本支撑，宁可漏报不错报。
- 三态结果：`notice`（表命中且 rule.extract(tree, env) 提取成功 → 广播；
  提取失败降级日志）/ `observed_unnamed`（528:382 已观测未命名 → 仅校准
  日志）/ `unknown`（其余 → 校准日志）。
- **校准日志 = 结构化摘要**（msgType/subType/群标识对/时间戳/actor/树内全部
  可打印字符串/raw hex 截断），替代 c3 的整包字节 JSON——下一轮拿到
  card/title 样本后只需往 KIND_TABLE 登记一条 extract 规则即可开始广播。
- `extractSysMsgEnvelope` 按 7.3 布局逐字段软失败（全部可空），翻译保持
  纯函数（ADR-008）。

## 8. kurobot 协议适配器（KuroBot MVP-3，2026-09-13；09-16 改名对齐 0.4.0）

> 协议说明见 `docs/protocols/kurobot.md`。napukettoqq 以「新增协议适配器」
> 方式原生说 kurobridge-ws：账号 TOML 配了 `[accounts.kurobot]` 段即启用，作为 **WS 客户端**
> 主动连入 KuroBot 服务端（KuroBot 恒为服务端），实现 QQ 群 ↔ MC 双向互通。
> 复刻 satori 模式（core 框架 + 薄映射层），不动 onebot11/satori/network/kernel。

### 8.1 协议契约与镜像决策

- **SSOT**：KuroAdapter `bridge/protocol/src/`（meta / frame / messages/ws）——
  镜像基线 **0.4.0**（子协议 `kurobridge-ws.v1`；0.3.1 首版落地后随 KuroAdapter
  **ADR-030 品牌改名**对齐：kurobot-ws.v1 → kurobridge-ws.v1、PROTOCOL_VERSION 0.4.0，
  帧形状逐字段不变，commit `5bc2aea`）。`@kurobot/protocol` 未发 npm、跨仓构建期依赖
  不可行 → `src/kurobot/schema.ts` 本仓**镜像实现**（逐字段抄录，文件头注明 SSOT 与基线）；
  golden 帧对表测试锁漂移（将来发版可切换依赖，债务见 NOTES）。
- **帧格式**：`{header: {type, id?}, body}`（单行 JSON 文本帧）。事件帧无 id；
  请求/响应帧 id 必填（UUID 关联）。收帧两段式：wireFrameSchema 取 type →
  分发到具体 schema；未知事件帧忽略、未知请求帧回同 id `<type>_result`
  `{ok:false, error:"unknown frame type"}`（对齐 KuroAdapter ADR-026 未知帧容忍，
  防乒乓循环：`_result` 结尾的未知响应帧不回执）。
- **IPC 侧消息**（ready/broadcast/execute_command 等）不镜像——那些是 KuroAdapter
  内部 Java↔Node 通道，WS 对端永不接触。

### 8.2 连接层（`connection.ts` KurobotConnection，自建不复用 network.WsClient）

不复用的四个协议语义理由（任务书 §1.2 决策二，已核实 network WsClient）：
① 服务端 `handleProtocols` 不带 `Sec-WebSocket-Protocol: kurobridge-ws.v1` 直接拒连，
WsClient 不支持子协议；② 服务端空闲检测只认**应用层入帧**（30s 阈值，WS 层 ping
不重置），必须发应用层 `ping` 帧；③ 每次连接（含重连）成功后必须**立即重发 hello**，
WsClient 无 onOpen 回调；④ 重连需感知 close code（1002/1008 停止重连），WsClient
固定延迟重连。

状态机：

```
idle ──start()──▶ connecting ──open──▶ establishing（发 hello，等 ack ≤ 10s）
                     ▲                     │ ack ok
                     │ 退避到点              ▼
                  backoff ◀──close────── established（15s 应用层 ping）
                     │
      close 1002（版本不符）/ 1008（token 错）/ hello_ack ok:false
                     ▼
                 rejected（永久停止，error 日志；其余关闭码持续指数退避 1s/2s/…/60s 封顶）
```

- **握手**：open 后立即发 `hello`（请求帧，UUID）：`{peerId: <本账号 uin>,
  platform: "qq", version: <adapter 版本>, protocolVersion: "0.4.0", token?非空才带,
  client?（缺省 napukettoqq，能取到包版本则 napukettoqq/<版本>）}`；收到同 id
  `hello_ack`：ok → 建立（回 `serverId/version/channelBindings`）；ok:false →
  永久停止（reason 进 error 日志）。
- **心跳**：established 后每 `pingIntervalMs`（缺省 15000）发应用层 `ping`
  请求帧（`{timestamp: Date.now()}`，任何入帧都会重置服务端 30s 空闲计时，半窗安全）；
  `pong` 不处理（收不到就等服务端 1001 关闭走重连）。
- **重连**：非用户关闭且非 1002/1008 → 指数退避 `1s * 2^attempt` 封顶 60s，重连成功
  （ack ok）清零 attempt；退避基数/上限/hello 超时可注入（测试用快值，生产缺省）。
- **出站队列**：无队列——未 established 时 send 直接丢弃 + debug 日志（服务端离线
  时消息本就无法送达，不积压陈旧消息）。

### 8.3 消息映射（`translate.ts` 纯函数）

**QQ → MC**（仅群聊 `chatType === GROUP`；自消息 `senderUin === selfUin` 恒过滤防回环）：

- `sender` = `sendMemberName ?? sendNickName`（双空兜底 `senderUin`，schema min(1)）；
  `channel` = `peerUid`（QQ 群号字符串，与 OB11 group_id 同源）。
- 富文本降级（canonical elements → 单行文本，text 原文、`at` → `@{display ?? uid}`、
  @全体 → `@全体成员`、image → `[图片]`、face → `[表情]`、reply → `[回复]`、
  其余类型忽略；结果空白 = 不发）。对齐 OB11「无法表达静默跳过」惯例。
- **命令**：`commandPrefix`（缺省 `/`）开头 → 去前缀 trim 作 `command` 帧
  `{command, source: {channel, userId: senderUin}}`（管理员判定在服务端）；空命令
  忽略；命令帧**不做绑定过滤**（服务端 dispatchCommand 不查绑定表，仅按 userId 判管理员）。
- **出站过滤**：`hello_ack.channelBindings` 快照 + `bindings_updated` 维护绑定集，
  非绑定群不发 chat 帧（debug 日志）；快照为空 = 全部不发（对齐服务端空绑定丢弃语义）。
- chat 帧为事件（无 id）：`{channel, sender, content}`。

**MC → QQ**（渲染模板可配置，占位符 `{player}`/`{content}`/`{message}`，MVP 纯文本）：

| 帧 | body | 缺省模板 |
|---|---|---|
| chat | `{channel, playerName, content}` | `[{player}] {content}` |
| join / leave | `{channel, playerName}` | `{player} 加入了服务器` / `{player} 离开了服务器` |
| death | `{channel, player, message}`（message 允许空串） | `{player} {message}`，message 空串时以「死亡了」代入 |
| status | `{tps, onlinePlayers, uptimeSeconds}` | 仅缓存不发群（防刷屏） |

- `bindings_updated`：`{channelBindings}` **全量快照**（非增量）→ 替换绑定集。
- `command_result`（响应，同 id）：**无 channel 字段**——adapter 维护
  `pendingCommands: Map<UUID, channel>` 关联回发目标；ok → `output` 各行 `\n` 合并
  （空 output 发「（命令执行成功，无输出）」占位），error → `命令失败：{error}`。
- 发群统一经 kernel `MsgApi.sendMessage({chatType: GROUP, peerUid: channel},
  [{type:"text", text}])`；目标群不存在/发送失败 → error 日志不抛出（不影响连接）。
- 发往 QQ 的文本统一 1500 字符截断（追加 `…(截断)`）。

### 8.4 配置段（`config.ts`，zod schema 归本包，ADR-012）

```toml
[accounts.kurobot]           # 段存在即启用、不写不启用（seed 注入对齐其它协议段）
url = "ws://127.0.0.1:25580" # 必填，完整 ws:// / wss:// 地址（KuroBot 服务端）
# token = ""                 # 鉴权 token（缺省空 = 不带；服务端配了 token 则必填）
# client = "napukettoqq"     # 自报身份（缺省 napukettoqq，能取到包版本则 napukettoqq/<版本>）
# commandPrefix = "/"        # 群命令前缀
# pingIntervalMs = 15000     # 应用层心跳间隔（服务端空闲阈值 30s，须 < 30000）
# chatTemplate = "[{player}] {content}"
# joinTemplate = "{player} 加入了服务器"
# leaveTemplate = "{player} 离开了服务器"
# deathTemplate = "{player} {message}"
```

### 8.5 装配点（对齐 satori 先例）

1. loader `host/core/assemble-protocols.ts`：kurobot 装配分支（**仅当账号段非空**
   才装配——url 必填，空段 parse 会炸；`loadProtocolSections` 增 `kurobotSection`）。
2. cli `config-parse.ts`：`ProtocolKey` 增 `"kurobot"`（宽松对象校验）。
3. cli `config-template.ts` + create-napukettoqq `templates/napuketto.toml.tmpl`：
   注释段模板。
4. `packages/adapter/package.json`：`ws ^8.21.1`（对齐 network）+ `@types/ws` devDep +
   `./kurobot` 子路径导出（ADR-014）+ tsdown entry。

### 8.6 测试（`*.test.ts` 与源码相邻，vitest 根配置）

- **假 kurobridge-ws 服务端**（`ws` 库起真端口，`handleProtocols` 复刻服务端校验）驱动
  连接层全链路：带子协议握手 / 不带被拒（HTTP 401 复现服务端行为）/ hello 0.4.0 +
  client + token / 应用层 ping / 断线指数退避重连且重发 hello / hello_ack error、
  1002、1008 停止重连。
- **golden 帧对表**：双向各 ≥3 种帧的线格式字面量（对表来源 commit `b0809ef` 注明
  在测试内），镜像 schema 双向解析 + encodeFrame 往返锁漂移。
- **映射**：合成 RawMessage（文本/@/图片/表情/回复/自消息过滤/空降级）→ 帧字段断言；
  渲染模板（含 death 空串、1500 截断、command_result error 分支）。
- **适配器级**：假服务端 + ProtocolConfig seed + 桩 msgChannel/msgApi 跑通
  QQ→MC chat/command 与 MC→QQ 渲染回群全链路。

## 9. milky 协议适配器（P0 2026-10-28，P1 2026-10-30）

> 协议说明与覆盖清单见 `docs/protocols/milky.md`（Milky 1.3.0）。第四个协议适配器，
> 单端口 HTTP（`POST /api/:api` + `GET /event` SSE/WS）+ WebHook，`@napuketto/adapter/milky`
> 子路径导出（ADR-014）。`[accounts.milky]` 段存在且 `enabled=true` 才生效。

### 9.1 结构与决策

- **类型层**：`types.ts` 手写 P0 子集（SSOT = 官方 JSON Schema 1.3.0，MIT，逐字段自研
  描述；未参考 GPL 实现源码）。P1 扩面时评估 `@saltify/milky-protocol` + `milkygen` 生成。
- **动作基类**：`action/base-action.ts` 与 OB11 `BaseAction` 分离——Milky 信封无 echo、
  参数失败恒 -400（规范）。错误映射 `error-map.ts`：-400 参数 / -403 未登录（规范），
  其余自定负数（-404 NOT_FOUND / -405 PERMISSION_DENIED / -409 INVALID_STATE /
  -500 SEND_FAILED·UNKNOWN / -504 TIMEOUT）。
- **seq↔msgId**（milky.md §5 方案二）：`helper/seq-index.ts` 双向映射（接收链路 record，
  FIFO 4096 封顶）；`get_message` / recall 反查未命中扫近段历史（fetchMessages 60 条）
  兜底。kernel 不动。
- **发送核心**（`action/message.ts` sendMilkyMessage）：OutgoingSegment → canonical
  （未知段跳过 = 规范兼容性；forward 显式报错 P1）→ at uin→uid 批量 → 远程媒体 URI
  落盘（`helper/media-uri.ts`：file:// 同步 / base64:// 解码落盘探扩展名 / http(s)://
  media downloadUrl；未配 cacheDir 报错）→ sendMessage → 回查 msgSeq/time（发送输出
  必需 message_seq，sendMessage 只回 msgId）。
- **事件**（`helper/translate.ts` 纯函数）：message_receive 三场景（group 场景 schema
  要求 group/group_member 实体——GroupCache 缓存优先 fail-soft 最小实体；friend 场景
  friend 实体 peerName 兜底）；message_recall（grayTip REVOKE，sender_id 取
  RawMessage.senderUin 待真实事件校准）。at uid→uin、reply 引用回填（seqIndex 反查）
  在广播路径异步取得后经 ctx 注入。自消息不上报（P0 固定）。
- **传输**（`transport.ts`）：network 2026-10-28 新原语承接——SSE（`createSseResponse`，
  `event: milky_event` 帧）走 `HttpServer.onRawRequest`，同端口 WS 升级走
  `HttpServer.onUpgrade`（token 校验含 `?access_token=` 查询参数兜底），WebHook 走
  `HttpClient`（Bearer 头）。事件枢纽 `MilkyEventHub` 注册 EventBroadcaster，send =
  SSE/WS 广播。HTTP 语义：401 鉴权 / 404 未知 API（空 body）/ 415 Content-Type /
  200 规范信封。

### 9.2 测试

`helper/translate.test.ts`（10 例：三场景形状 / 段映射 / 回填 / unknown 跳过）、
`action/message.test.ts`（7 例：发送链 canonical 断言 / 输出映射 / -400 / 注册表）、
`transport.test.ts`（7 例，真端口：信封 / 404 / 415 / 401 / SSE 推送 / WS 升级）。

### 9.4 P1 测试

`helper/notice.test.ts`（11 例：成员增减两形态 / 禁言 / 全员禁言 / 改名 / 解散守卫 /
戳一戳群与好友 / 未知子类型日志）、`helper/request.test.ts`（7 例：好友申请 / 入群
申请 / 成员邀请 / 邀请自身 / 状态过滤）、`action/p1-actions.test.ts`（9 例：注册表
49 名齐 / 通知实体五变体 + 分页 / 精华翻译 + 分页 / 群文件实体 / schema -400）、
`seq-index.test.ts` +1（转发索引）。

### 9.3 P1 扩面（2026-10-30）

**接口扩面（+40 动作，总 49）**——覆盖 milky.md §6 的 ✅ 46 中可落地的部分；延后项见下。
文件按域拆分：`action/profile.ts` 新（资料/票据 7 个）、`action/social.ts` 扩（好友操作
5 个）、`action/message.ts` 扩（历史/转发内容/已读 3 个）、`action/group.ts` 新（群管 +
精华 + 表态 + 通知 16 个）、`action/group-file.ts` 新（群文件 7 个）。

- **依赖扩充**：MilkyApi +profileLikeApi / ticketApi / webApi / groupNotifyApi /
  richMediaApi（loader services 已有，装配透传）；`self` 扩 `uid`（loader
  kernel-services 从 loginResult.uid 透传，get_friend_requests 的 target_user_uid 用）。
- **uin→uid 入参转换**：以 uid 为入参的 kernel API（名片/管理员/禁言/踢人/点赞/删好友/
  应答好友申请）经 `MilkyApi.uinToUid` 批量转换，失败抛 INVALID_PARAM（入参非法）。
- **请求应答**（accept/reject_group_request、accept/reject_group_invitation）：
  seq 入参 → `getSingleScreenNotifies(doubt=is_filtered)` 按 seq 匹配（OB11
  set_group_add_request 同路径，先非可疑后可疑）→ `handleGroupRequest`。
  notification_type 入参仅作 schema 校验（匹配按 seq，通知对象自带 type）。
- **精华列表**：`WebApi.getEssenceMsgList` → GroupEssenceMessage（msg_content
  msg_type 1→text / 2→image 近似翻译；page_index/page_size 客户端分页；message_time
  无源取 operation_time 兜底）。设置/取消精华：seq → resolveMsgIdBySeq →
  add/removeGroupEssence。
- **历史消息**：start_message_seq → resolveMsgIdBySeq → `fetchMessages`（msgId 锚点）
  → 逐条 seqIndex.record + 实体回填翻译；输出按 message_seq 升序（原生新→旧，反转），
  next_message_seq = 最旧一条（不满 limit → null）。
- **转发内容**：接收段 forward.forward_id 从「容器 msgId」改为 **resId**（规范语义
  「转发消息 ID」，取 multiForwardMsgElement.resId）；seqIndex 增加转发索引
  resId → {chatType, peerUid, msgId}（接收链路登记），get_forwarded_messages 经索引
  取 peer → `fetchForwardMessage`（forward_id 未登记 → NOT_FOUND）。
- **群文件实体**：GroupFileItemInfo / GroupFolderInfo → GroupFileEntity /
  GroupFolderEntity（fileSize 字符串转数值；expire_time / downloaded_times /
  uploader 无源字段 0/null 兜底）。download url / rename_folder / resource 反查 /
  nudge 发送 kernel 无出口，P2 探测（见 milky.md）。

**事件扩面（+13，总 15）**——复用 OB11 已打通的两类数据源，翻译为 Milky 形状：

- **grayTip 系**（`helper/notice.ts` 新，判据对齐 OB11 helper/notice.ts）：
  group_member_increase（MEMBER_ADD：adminUid===memberUid → operator_id 否则
  invitor_id）、group_member_decrease（QUIT：adminUid 非空且 ≠ member 时给
  operator_id）、group_mute / group_whole_mute（SHUT_UP：member uid 空 = 全员禁言，
  is_mute = duration>0）、friend_nudge / group_nudge（aioOpGrayTipElement，
  best-effort + raw 校准日志，与 OB11 poke 同口径待真实事件校准）、
  group_file_upload（群消息含 fileElement → **替代** message_receive，文件消息的
  Milky 语义即上传事件；friend 场景仍走 message_receive 带 file 段）。
- **通道系**（`helper/request.ts` 新）：adapter options +groupChannel +buddyChannel
  （loader services 已有）。friend_request（Buddy/onBuddyReqChange，
  narrowBuddyReqs 防御收窄，comment 取 words 字段）；group_join_request /
  group_invited_join_request / group_invitation（Group/onGroupNotifiesUpdated，
  仅 KUNHANDLE 状态，type 1=邀请自身 / 5=成员邀请他人 / 7=入群申请，
  is_filtered = doubt 参数，notification_seq = Number(seq)，user1/user2 uid→uin）。
- uid→uin 批量转换在广播路径异步取得后经 ctx 注入（同 P0 纯函数模式）。
- **未接**（无源或源待校准，P2）：group_message_reaction / peer_pin_change（无推送
  源）、group_essence_message_change（kernel 只打原始日志）、bot_offline（kernel 离线
  事件待确认）、friend_file_upload（onRecvOfflineFileMsg 形状未定）。
  group_name_change / group_disband 已接（grayTip GROUP_NAME_MODIFIED / DISBANDED，
  操作者 uid 不可得时不产出事件）。
