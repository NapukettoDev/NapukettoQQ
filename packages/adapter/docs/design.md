# @napuketto/adapter 设计书

> 协议适配器容器（ADR-013）：framework 框架 + onebot11 / satori / kurobot / milky 四个协议目录。
> 管协议信封、事件翻译、动作分发与传输装配；不管原生调用、传输原语与媒体编解码。
> 源码入口：`src/framework/`（公开契约）、`src/internal/`（包内私有）、`src/<protocol>/`（各协议薄映射）。

## 核心机制

### 目录分层与可见性

| 目录 | 可见性 | 装什么 | 依赖约束 |
|---|---|---|---|
| `src/framework/` | **公开**：`exports["./core"]` | 适配器骨架：`BaseProtocolAdapter` / `ActionRegistry` / `runAction` / `auth` / `transport-schema` | 只依赖 kernel / network；禁止依赖 `internal/` 与任何协议目录 |
| `src/<protocol>/` | 公开：各自子路径 | 协议信封、事件翻译、动作声明、传输装配 | 可依赖 `framework/` + `internal/`；协议之间互不依赖 |
| `src/internal/qq/` | 包内私有 | NTQQ 数据语义与边界桥接：sysmsg 解码、uid↔uin 口径、grayTip、essence 字段提取、raw-message 归一、发送侧媒体准备 | 可依赖 `internal/infra/` 与 `@napuketto/media`；无 barrel |
| `src/internal/infra/` | 包内私有 | 协议无关的运行期横切件：日志截断与校准 logger 面 | 叶子层，不依赖 `qq/` 与 `framework/` |

- **可见性轴优先于「协议 / 非协议」轴**：公开契约（`framework/`）与包内实现（`internal/`）
  物理分开，`internal/` 下不放任何 `index.ts`——防止顺手的 `re-export` 把私有实现变成
  事实 API，也保住 ADR-014 的按需加载。
- **源码名与产物名刻意不同**：`src/framework/index.ts` 经 `package.json` 的 tsdown 对象
  entry `core/index` 构出 `dist/core/index.mjs`，公开子路径仍是 `@napuketto/adapter/core`。
  loader 按 `adapterEntry.replace(INDEX_MJS_RE, "core/index.mjs")` 字符串拼接取入口、
  不看 `exports` 映射，故 `dist/` 镜像公开子路径、`src/` 镜像内部分层。
- 边界靠门禁而非约定：biome `noRestrictedImports` 禁止 `framework/**` import `internal/**`。

### 统一模型与生命周期

- 统一面只有两处：消息以 kernel `CanonicalElement` 为内部模型，动作统一为
  `{ name, schema, handle }` 声明式对象（各协议 `defineXxxAction` 工厂产出，
  信封差异收在各自 base-action 运行时）；事件保留各协议原生结构（OB11 事件 /
  Satori Event / Milky event / KuroBot 帧），不引入第二套内部事件抽象。
- `BaseProtocolAdapter<TConfig>`（`src/framework/base-protocol-adapter.ts`）：
  `start()` = `config.load()` → `hooks.onStart`；`stop()` → `onStop`；
  `reload()` = 重新 `load()` → `hooks.onReload`。start/stop 幂等（started 标记），
  事件出口 `broadcastEvent` 只写构造时注入的 broadcaster。钩子面
  `ProtocolHooks<TConfig>` 与适配器同参数化：onStart/onReload 强类型透传协议配置，
  协议层不再手动收窄。
- 配置直接复用 kernel `ConfigBase`：TOML/JSON 读写 + zod 校验 + `seed` 内存初值；
  协议 schema 归各协议目录（ADR-012）。装配层按账号段注入 seed，adapter 不读独立协议配置文件。
- 动作执行内核 `runAction`（`src/framework/action-kernel.ts`，三协议共用）：
  safeParse → 执行 → `isKernelError` 统一判别映射（ADR-017）。差异全部参数化——
  校验失败 retcode（OB11 400/1400、Milky -400、Satori 400）、校验失败消息、
  结果包装（OB11/Milky 组信封、Satori 抛 `SatoriActionError`）与协议自有错误透传
  （`passthrough`）。非 KernelError 一律落映射表 UNKNOWN 兜底，不做形状嗅探。
- 动作运行时按协议分文件（`defineOb11Action` / `defineMilkyAction` / `defineSatoriAction`）：
  声明 `name` + zod `schema` + `handle`，工厂闭包依赖并统一信封与错误映射（OB11 HTTP 400 /
  WS 1400 + echo；Milky -400；Satori 抛 `SatoriActionError`）。`ActionRegistry` 按名分发，
  未知动作 404。装配方直接持有各协议适配器（不设 AdapterRegistry 中间层）。
- OB11 动作文件按领域组织：`action/` 下 message / group / friend / system 领域文件
  （声明式动作与 `create*Actions(api)` 工厂同文件，≤300 行）；错误码映射与 uid 解析收在
  `action/base-action.ts`，`index.ts` 只遍历工厂注册零样板。
- Milky 动作文件按领域组织：`milky/action/` 下 group（query / manage / essence /
  notice，另有群文件 `group-file` 一域）/ message（send / query / ops）+ profile /
  social / system，声明式动作与领域工厂同文件（每文件 150~300 行）；`index.ts`
  按领域工厂顺序遍历注册。
- 协议目录内不设转发 barrel：`index.ts` 只保留 `package.json` `exports` 声明的
  6 个子路径入口与实际聚合面（注册表/类型聚合）；单模块转发壳一律直引目标模块。
- `framework/auth.ts` 提供协议层 Token 鉴权原语：`matchTokenCredential` 按
  `TokenAuthOptions` 参数化 Bearer 头、可选裸 `authorization` 头（OB11 兼容）与
  可选 `?access_token=` 查询参数（OB11 / Milky，固定以 `http://localhost` 为 base
  解析相对路径）；`createTokenAuthorize` 在 token 为空时返回 `undefined`（不装钩子）。
  三协议 transport 只声明方言开关，不各自重复解析。
- fail-soft 降级分支必须留痕：kernel API 调用失败（uid↔uin、群缓存读、媒体下载）→
  `warn`；纯解析兜底（鉴权 URL fail-closed、`file://` 剥前缀）→ `debug` 或映射语义
  注释。logger 经构造注入（`MilkyApi.logger` / `OneBotApi.logger`），纯翻译函数体内
  不引 logger；保留项：sysmsg `decodeText` 三态与 satori 翻译层（无 logger 基建）。
- 测试桩强类型化：禁止对桩对象 `as unknown as` 暴力强转，统一经 `internal/__tests__/stub.ts`
  的 `stub<T>`/`stubList<T>` 与各协议 `test-support.ts` 强类型工厂。豁免：私有字段
  窥视、故意畸形输入、私有 internals 断言；碎片测试（`*-branches`/`*-extra`）并入
  主测试文件，不新增。
- 协议隔离：装配方为每个协议实例化独立 `EventBroadcaster`；adapter 只向自己注入的
  broadcaster emit，不跨协议共享事件或缓存。
- 跨协议 QQ 共享原语收在包内 `src/internal/qq/`（不对外导出）：uid-uin 的 `toUin`/`toUinString`/
  `numericUin`（number / string / 数字串口径）、`collectGroupNotifyUids`（群通知 user1/user2
  双方 uid）与 `resolveUidToUinWithFallback`（去重空串 → 批量 `uidToUin` → 群口径未命中的
  前 `MAX_PROFILE_LOOKUPS` 条逐条资料兜底，fail-soft 留痕；OB11 / Milky enrichment 共用）、
  gray-tip 的 `hasGrayTip`/`findRevokeElement`、
  raw-message 的数组规范化与 `toUnixSeconds`（Windows 毫秒 / Linux 秒归一）、
  log 的 `truncRaw`/`sliceRaw`/`AdapterLoggerLike`（raw 日志截断两口径 + 校准 logger
  面）、text 的 `firstNonEmptyString`/`stringOrUndefined`（NT 原生字段「空串 vs 省略」
  择一取值）、startup-cutoff 的 `STARTUP_GRACE_SEC`/`startupBaselineSec`（启动 / 重连的
  历史积压基准，四协议共用）、buddy-req 的 `isActionableBuddyReq`/`filterBuddyReqs`/
  `processInboundBuddyReqs`（unreadNums 短路 → 收窄 → 过滤 → 去重的入口管线）/
  `BuddyReqDedup`（好友申请可处理性判定与实例级去重）；协议目录只留形状差异（事件翻译、
  识别表、错误口径——NOT_FOUND 抛错类型与消息归调用方）。
- 群精华列表缓存 / 首帧基线抑制 / 串行 diff 同步器已下沉 kernel 缓存层（ADR-028）：
  `EssenceListSync` / `diffEssenceList` / `narrowEssenceGroupArg` 从 `@napuketto/kernel`
  导入；`src/internal/qq/essence.ts` 只保留 `extractEssenceSetSysMsg`（732:1 字段提取）。
- adapter 协调层分层：巨型 `adapter.ts`（onebot11 / milky / kurobot）拆为四块——
  `adapter.ts` 只留构造装配、生命周期钩子与传输启停（OB11 另有 IPC 桥
  `subscribeOnly` / `unsubscribeOnly` 公共面；kurobot 另持连接生命周期与
  query/status 公共面）；`event-pipeline.ts` 是纯订阅接线板（管理 unsubscribes
  与 applyConfig 开关，频道 → 域处理器路由，<100 行）；事件域处理在各协议
  `inbound/`（message / sysmsg / essence / request / file-notice 等，单文件
  ≤110 行；kurobot 双向流另有 session.ts 共享状态）；`enrichment.ts` 接管翻译
  前的异步查询（批量 uidToUin、群实体回填、msgId 反查），翻译函数保持纯函数
  （ADR-008）。sysmsg 单条字节块的解码 → 信封 → 识别 → 分流管线收拢
  `internal/qq/sysmsg.ts` `processSysMsgBlob`，协议只持识别表与命中处理。

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
- 好友申请只推「实时待处理」项（issue #122）：`isInitiator=true`（自己发起）、
  `isUnread=false`（已读）、`unreadNums=0`（显式 `isUnread=true` 的项除外，防错杀）、
  `isDecide=true`（reqType 13 `KMEINITIATORWAITPEERCONFIRM` 除外）与启动前历史积压
  （`reqTime < 订阅基准 −5s`）一律丢弃；批级 `unreadNums=0` 整批短路。剩余项按
  `${friendUid}:${reqTime}` 实例级去重（cache 上限 512，跨 `reloadTransports` 保留）
  ——否则「全量重放 → 自动同意 → 再次全量重放」会成死循环。`comment` 取
  `extWords ?? words`（QQNT 实际字段是 `extWords`）。
- notice：grayTip REVOKE → group_recall / friend_recall；aioOp → notify.poke（字段口径
  待真实事件校准，路径恒打 raw 日志）；群成员变动/管理/禁言走 TipGroupElement。
  `groupUploadAsNotice=false` 时文件消息报 message + file 段，true 时报 group_upload。
- 精华：唯一发射路径是 `Group/onGroupEssenceListChange` 列表 diff（`@napuketto/kernel`
  `EssenceListSync`，ADR-028）；sysmsg 732:1 只作
  加速触发器踢入同一串行链（diff 幂等 + 串行去重）。sender 缺失跳过事件；operator 仅
  add 回填；message_id 经近段 60 条反查 + MessageUnique 幂等分配。

### Satori 事件与媒体转换

- 事件：`message-created`、`message-deleted`、`guild-member-added/removed`；sn 从 1
  递增，启停广播 `login-updated`（在线/离线）。非登录事件只带最小 login 字段。
  消息订阅与 OB11 / Milky 共用 `subscribeRawMessages`（启动前历史消息同样拦截）。
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
- 收向订阅同样走 `subscribeRawMessages`：启动前历史群消息不触发向服务端的回帧。

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
  protobuf 字节（带符号 int8 数组）。共享层在 `src/internal/qq/sysmsg.ts`，OB11 与
  Milky 各自只维护识别表。
- 解码：`decodeProtoTree` 手写 wire-format（varint + length-delimited，BigInt 保 64 位；
  定长 wire 跳过；深度/字段数/varint 长度设上限），length-delimited 递归 try-parse，
  失败挂不透明 bytes。
- 收窄：`narrowSysMsgBlobs` 接受批数组 / 单块裸数组 / TypedArray，逐项 `& 0xFF`。
- 识别：`recognizeSysMsg(msgType, subType, table, observedUnnamed)` 三态——`notice`
  （表命中且 extract 成功）/ `observed_unnamed` / `unknown`；后两者只打结构化校准日志，
  不广播半成品。识别表键 = 原生分发键 `msgType:subType`：OB11 现含 732:21 群名片，
  Milky 现含 732:16 表情回应与 732:1 精华；528:349/381/382 为已观测未命名。
- 通用管线：`processSysMsgBlob`（单条字节块：解码 → 信封 → 识别 → onNotice 分流 →
  未识别 debug 校准日志）为 OB11 / Milky 共用流程；协议差异只在识别表、命中处理
  与解码失败日志级别（OB11 warn / Milky debug，既有口径刻意不统一）。
- 732:1 精华的字段提取器（`extractEssenceSetSysMsg`）留在 `src/internal/qq/essence.ts`；
  其上的列表缓存 / diff / 首帧基线抑制由 kernel `cache/essence-cache.ts` 承担（ADR-028）。
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
  群精华列表 diff 原语 `EssenceListSync` / `diffEssenceList` / `narrowEssenceGroupArg`
  （ADR-028）；
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
- 缓存只读（ADR-008）：diff / baseline / 首帧抑制属 kernel 缓存层（`cache/essence-cache.ts`，
  ADR-028），adapter 不写缓存；精华列表拉取用 kernel 串行链（并发回写会把新列表覆盖成旧列表）。
- 元素存在性一律 `!= null`：Linux 原生对象把未命中的变体显式置 null，`!== undefined` 会误判（直读字段抛错或普通消息误入分支）。
- 时间统一经 `toUnixSeconds`：兼容 Windows 毫秒与 Linux 秒，禁止在翻译里直接 `/1000`。
- 启动前历史积压一律拦截（issue #122）：QQNT 在登录 / 重连时会把历史消息与旧好友申请
  全量重放，收链路只报「实时」数据。消息侧在 `subscribeRawMessages` 统一按订阅时刻
  （−`STARTUP_GRACE_SEC` 5s 容差）过滤，四协议共用同一入口；好友申请侧按 `reqTime`
  同口径过滤。`msgTime` / `reqTime` 缺失或非法（归一为 0）时**放行**——宁可多报不可错杀。
  拦截条数以 debug 留痕，不逐条刷屏。
- 自身消息默认不广播（OB11 / Milky 一致）；无法表达的段/元素静默跳过；未知 CQ 码保留原文，保证往返不丢数据。
- 协议隔离：一协议一 broadcaster；adapter 不跨协议共享事件、不向别的协议端口写数据。
- 文件投递语义降级是明示契约，不得改回「假 fileUuid」实现（静默假成功）。
- 热更新：OB11 IPC 桥模式无传输，只刷新上报开关；其余协议 stop → 按新配置重建；
  `reload()` 只对已启动实例生效（未 start 时 no-op，防「传输已运行但 started=false」的不一致）。
- 生命周期守卫：骨架 start/stop 并发去重（stop 等待进行中的 start）；Satori 非登录事件
  `login.sn` 固定 0（登录序号≠事件 sn）；OB11 错误响应（404 / 异常兜底）同样透传 `echo`。
- 依赖面：不新增运行时依赖；KuroBot 客户端用 Node 内置 `WebSocket`，`ws` 仅 devDependency。
- **协议配置输入不叠 `Record<string, unknown>` 逃生舱**：`ProtocolConfigInput` 只接受
  `ConfigBase<T>` / `Partial<T>` / `undefined`；宽兜底会让别的协议配置（或仅带 `load()`
  的对象）绕过字段约束。鸭子类型 `load()` 只保留给单测 mock，Plain Object 一律走
  `schema.parse`（内存 seed 分支）。
- 历史决策见 [decisions](../../../docs/architecture/decisions.md)；实测样本见
  [evidence](./evidence.md)。
