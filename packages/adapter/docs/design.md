# @napuketto/adapter 设计书

> 协议适配器容器（ADR-013）：core 框架 + onebot11 / satori / kurobot / milky 四个协议目录。
> 管协议信封、事件翻译、动作分发与传输装配；不管原生调用、传输原语与媒体编解码。
> 源码入口：`src/core/`（框架与共享层）、`src/<protocol>/`（各协议薄映射）。

## 核心机制

### 统一模型与生命周期

- 统一面只有两处：消息以 kernel `CanonicalElement` 为内部模型，动作统一
  `BaseAction` + `ActionResult`；事件保留各协议原生结构（OB11 事件 / Satori Event /
  Milky event / KuroBot 帧），不引入第二套内部事件抽象。
- `BaseProtocolAdapter<TConfig>`（`src/core/framework/base-protocol-adapter.ts`）：
  `start()` = `config.load()` → `hooks.onStart`；`stop()` → `onStop`；
  `reload()` = 重新 `load()` → `hooks.onReload`。start/stop 幂等（started 标记），
  事件出口 `broadcastEvent` 只写构造时注入的 broadcaster。
- `ProtocolConfig`（`src/core/framework/config.ts`）复用 kernel `ConfigBase`：TOML/JSON
  读写 + zod 校验 + `seed` 内存初值；协议 schema 归各协议目录（ADR-012）。装配层按账号段
  注入 seed，adapter 不读独立协议配置文件。
- `BaseAction`：`name` + zod `schema` + `errorCodeMap`；HTTP `handle` 校验失败 400、
  WS `websocketHandle` 失败 1400 并回传 echo；`KernelError.code` 经映射表转协议 retcode
  （ADR-017）。`ActionRegistry` 按名分发，未知动作 404。
- `AdapterRegistry` 提供按 `protocol` 注册与批量 start/stop 的公共面（装配方可选，
  当前 cli/loader 直接持有各协议适配器）。
- 协议隔离：装配方为每个协议实例化独立 `EventBroadcaster`；adapter 只向自己注入的
  broadcaster emit，不跨协议共享事件或缓存。

### OneBot 11 事件链

| kernel 源 | 翻译 | 产出 |
|---|---|---|
| Msg/onRecvMsg（含 grayTip） | message-event / notice | message / notice |
| Group/onGroupNotifiesUpdated | request | group request |
| Buddy/onBuddyReqChange | request | friend request |
| Buddy/onBuddyListChange(V2) | 仅 raw 日志 | 无 |
| Msg/onRecvOfflineFileMsg | notice-extra | offline_file notice |
| Msg/onRecvSysMsg | sysmsg 解码/识别 | 按识别表 |
| Msg/onRecvOnlineFileMsg | 仅 raw 日志 | 无 |
| Group/onGroupEssenceListChange | essence diff | group_essence notice |
| BuddyCache/onBuddyAdded | notice | friend_add notice |

- 收方向 ID 转换在边界批量：at uid→uin、reply NT msgId→OB11 id；群消息 `sender.role`
  查 GroupCache（失败回退 member），经 ctx 注入，翻译仍是纯函数（ADR-008）。
- 自身消息默认丢弃（`reportSelfMessage` 可开）；`messagePostFormat` 为 array / string
  决定 `message` 字段与 `raw_message` 的呈现。
- request：GroupNotify type 1/5=invite、7=add，只推未处理（KUNHANDLE），flag=seq；
  doubt 可疑通知跳过。BuddyReq flag=reqTime；未知形状打 raw 日志。
- notice：grayTip REVOKE → group_recall / friend_recall；aioOp → notify.poke（字段口径
  待真实事件校准，路径恒打 raw 日志）；群成员变动/管理/禁言走 TipGroupElement。
  `groupUploadAsNotice=false` 时文件消息报 message + file 段，true 时报 group_upload。
- 精华：唯一发射路径是 `Group/onGroupEssenceListChange` 列表 diff；sysmsg 732:1 只作
  加速触发器踢入同一串行链（diff 幂等 + 串行去重）。sender 缺失跳过事件；operator 仅
  add 回填；message_id 经近段 60 条反查 + MessageUnique 幂等分配。

### Satori 事件与媒体转换

- 事件：`message-created`、`message-deleted`、`guild-member-added/removed`；sn 从 1
  递增，启停广播 `login-updated`（在线/离线）。非登录事件只带最小 login 字段。
- 消息 content 是 XML 风格字符串：`parseElements` 容错解析（注释、实体、无值属性、
  未配对标签），`renderElements` 序列化；canonical 双向转换在 `element-convert.ts` /
  `canonical.ts`。
- 媒体：img / audio / video / file → canonical；audio 走 `ensureSilk`（非 silk 转码）；
  video 非 mp4 走 `transcodeVideo`，ffmpeg 缺失或失败 fail-soft 原样透传；file 的
  `title` 映射为 canonical `name`。

### KuroBot 自建连接层

- `KurobotConnection`（`src/kurobot/connection.ts`）用 Node 内置 `WebSocket`，不复用
  network `WsClient`（ADR-021）：需子协议 `kurobridge-ws.v1`、应用层 ping、每次连接
  重发 hello、按 close code 决定是否重连。
- 状态机：connecting → establishing（发 hello，10s 等 ack）→ established（缺省 15s ping）；
  非永久断开走 backoff 1s/2s/…/60s；close 1002/1008 或 hello_ack ok:false → 永久停止。
  未 established 时发送直接丢弃，不排队。
- 帧：`{header:{type,id?},body}`，事件帧无 id、请求/响应帧 id=UUID；未知事件帧忽略，
  未知请求帧回 `<type>_result` 失败回执（`_result` 结尾不再回执，防乒乓）。
- 映射：QQ 群消息 → 富文本降级单行文本 → chat 帧；`commandPrefix` 开头 → command 帧。
  服务端帧 chat/join/leave/death 按模板渲染回群文本，status 只缓存，command_result 经
  pending UUID 找回发群；绑定集来自 hello_ack + bindings_updated（全量替换），非绑定群
  不发。发往 QQ 的文本 1500 字符截断。
- 纯出向协议：不向 broadcaster 发事件。

### Milky 单端口传输

- 单端口 HTTP：`POST /api/:api` 动作，`GET /event` SSE 或同端口 WS 升级；WebHook 走
  `HttpClient` 主动推送。事件统一经 `MilkyEventHub` 广播（`event: milky_event`）。
- 鉴权：token 非空时校验 Bearer 头或 `?access_token=`；HTTP 语义 401 鉴权、404 未知
  API（空 body）、415 Content-Type、200 规范信封。
- 收链路三源：消息通道（seq 登记 → grayTip notice / 群文件上传 / message_receive）、
  群通知、好友申请；另接 sysmsg（732:16 表情回应、732:1 精华快路径）、最近会话置顶
  翻转、登录掉线、私聊文件。自消息不上报。
- `enabled=false` 时完全空转（不订阅、不起传输）；热更新停止后按新配置重建。
- 发送：OutgoingSegment → canonical（未知段跳过）→ at uin→uid → 远程媒体落盘 →
  `sendMessage` → 回查 msgSeq/time（发送输出必需 message_seq）。

### 消息段双向转换管线

| 协议 | 收向（canonical → 协议） | 发向（协议 → canonical） |
|---|---|---|
| OB11 | `canonicalToSegments` / `canonicalToCqMessage` | `segmentsToCanonical` / `cqMessageToCanonical` |
| Satori | `canonical.ts` → XML | `element-convert.ts` XML → canonical |
| KuroBot | `degradeElements` 单行文本 | 无（纯出向） |
| Milky | `canonicalToIncomingSegments` | `outgoingSegmentsToCanonical` |

- OB11：无法表达的 canonical 元素静默跳过；未知 segment 兜底按 xml；未知 CQ 类型保留
  原文为 text 段（往返不丢数据）。CQ 转义/反转义与解析是纯函数（`helper/codec/`）。
- Satori：解析/渲染 XML；媒体元素在 `helper/element/media-convert.ts` 做本地化与转码。
- KuroBot：text 原文、at → `@{display ?? uid}`、@全体 → `@全体成员`、image / face /
  reply 占位；其余类型忽略，结果空白不发。
- Milky：收向 12 种（market_face / markdown 无 canonical 对应，未知跳过）；发向 10 种，
  forward 顶层段不走本转换器（组装链分流，混发/嵌套显式拒绝）；json → light_app，
  xml → xml。

### sysmsg 解码与识别

- `Msg/onRecvSysMsg` 是群名片/头衔/精华/表情回应等系统事件的总闸，payload 是原始
  protobuf 字节（带符号 int8 数组）。共享层在 `src/core/shared/sysmsg.ts`，OB11 与
  Milky 各自只维护识别表。
- 解码：`decodeProtoTree` 手写 wire-format（varint + length-delimited，BigInt 保 64 位；
  定长 wire 跳过；深度/字段数/varint 长度设上限），length-delimited 递归 try-parse，
  失败挂不透明 bytes。
- 收窄：`narrowSysMsgBlobs` 接受批数组 / 单块裸数组 / TypedArray，逐项 `& 0xFF`。
- 识别：`recognizeSysMsg(msgType, subType, table, observedUnnamed)` 三态——`notice`
  （表命中且 extract 成功）/ `observed_unnamed` / `unknown`；后两者只打结构化校准日志，
  不广播半成品。识别表键 = 原生分发键 `msgType:subType`：OB11 现含 732:21 群名片，
  Milky 现含 732:16 表情回应与 732:1 精华；528:349/381/382 为已观测未命名。
- 字节布局、样本清单与字段号依据见 [evidence](./evidence.md#msgonrecvsysmsg-字节布局)。

### 文件投递：闪传语义降级

- QQ NT 没有「传进群文件列表」的 NAPI；`sendMsg` 带 fileElement 的文件传输命令被服务端
  拒绝，`fileUuid` 拿不到。唯一可用通道是闪传：`FlashTransferApi.sendFile`（上传文件集 +
  发分享卡片）。
- 语义降级：对端收到 `qfile.qq.com` 分享卡片，不是 fileElement 文件消息、不进群文件
  列表；返回 `file_id = fileSetId`，不能喂给群文件查询/删除动作；`folder` 仅 schema
  兼容（闪传无目录概念）。
- OB11 `upload_group_file` / `upload_private_file` 只接受本地路径与 `file://`，远程
  URI 明确报参数错误；Milky 侧经 `resolveUriToPath`（远程落盘）。

## 跨包契约

- kernel（只消费，不修改）：`MsgApi` / `GroupApi` / `WebApi` / `RichMediaApi` /
  `RecentContactApi` / `FlashTransferApi` 等语义 API；事件通道 `MsgEventChannel` /
  `GroupEventChannel` / `BuddyEventChannel` / `BuddyCacheEventChannel` /
  `RecentContactEventChannel` / `LoginEventChannel`；只读缓存 `GroupCache` / `BuddyCache`；
  类型与错误 `CanonicalElement` / `RawMessage` / `ChatType` / `KernelError` / `kernelError`。
- network（只消费）：`EventBroadcaster`、`TransportAdapter`、`HttpServer`、`WsServer`、
  `HttpClient`、`WsClient`、`createSseResponse`、`isWsOpen`、鉴权钩子；network 不 import
  任何协议包（ADR-002）。
- media（只消费）：`encodePcmToSilk` / `transcodeVideo` / `extractVideoFrame` /
  `getVideoInfo` / `downloadUrl` / `inferExtension` / `detectFileType`；只有 adapter
  依赖 media，kernel 不背媒体依赖（ADR-011）。
- 原生边界：adapter 不 `dlopen`、不 import `wrapper.node`、不注册原生 listener；所有
  原生交互经 kernel（红线）。装配注入全部走构造参数（api / channel / cache / logger），
  adapter 无全局单例。
- 错误传播：kernel 抛类型化错误 → 动作层映射 retcode；传输/翻译失败只打日志，不把
  连接或事件链打断。翻译函数内部不吞异常语义，调用方在边界 catch 并记录。
- 包导出：`.` / `./core` / `./onebot11` / `./satori` / `./kurobot` / `./milky`
  （ADR-014）；消费方只加载用到的协议子路径。

## 关键取舍与不变量

- 翻译层纯函数（ADR-008）：只读入参；uid→uin、msgId 反查、缓存查询都在协议边界的
  enrichment 完成，结果经 ctx 注入。改翻译不得新增 API 调用或缓存读取。
- 缓存只读（ADR-008）：diff / baseline / 首帧抑制属于 kernel 缓存层；adapter 不写缓存。
  精华列表拉取用串行链（并发回写会把新列表覆盖成旧列表）。
- 元素存在性一律 `!= null`：Linux 原生对象把未命中的变体显式置 null；`!== undefined`
  会让普通消息误入 grayTip 分支。
- 时间统一经 `toUnixSeconds`：兼容 Windows 毫秒与 Linux 秒，禁止在翻译里直接 `/1000`。
- 自身消息默认不广播（OB11 / Milky 一致）；无法表达的段/元素静默跳过；未知 CQ 码保留
  原文，保证往返不丢数据。
- 协议隔离：一协议一 broadcaster；adapter 不跨协议共享事件、不向别的协议端口写数据。
- 文件投递语义降级是明示契约，不得改回「假 fileUuid」实现（静默假成功）。
- 热更新：OB11 IPC 桥模式无传输，只刷新上报开关；其余协议 stop → 按新配置重建。
- 依赖面：不新增运行时依赖；KuroBot 客户端用 Node 内置 `WebSocket`，`ws` 仅 devDependency。
- 历史决策见 [decisions](../../../docs/architecture/decisions.md)；实测样本见
  [evidence](./evidence.md)。
