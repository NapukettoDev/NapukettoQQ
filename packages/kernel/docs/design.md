# @napuketto/kernel

> 唯一原生交互层：负责 `process.dlopen`、`wrapper.node` 会话与原生 listener、事件桥、语义化
> API、类型层、登录与平台参数；不含协议映射（adapter）、媒体处理（media）、宿主引导（loader）。
> 源码入口：`src/wrapper/`、`src/bridge/`、`src/event-channel.ts`、`src/apis/`、`src/types/`。

## 核心机制

### 装配与数据流

```text
loader ──dlopen/startNapuketto──▶ wrapper.node（engine → session）
  │                                     │ session.getXxxService()
  ▼                                     ▼
NapukettoCore ──▶ CoreContext     Msg/Group/Buddy/…Bridge（每 service 一个原生 listener）
                                        │ emit `${Service}/${method}`
                                        ▼
                                  NTEventChannel ──▶ 缓存（只读维护）
                                        │            └▶ adapter 订阅（协议翻译）
                                        ▼
                                    apis/*（语义化调用，失败抛 KernelError）
```

- 装配入口 `NapukettoCore.create` → `attachWrapper` → `login`，状态集中在 `CoreContext`
  （paths / logger / wrapper / login），不引入全局单例。
- `wrapper-loader` 负责 dlopen 后的 engine/session 初始化与平台配置；`session-resolver`
  提供主 session 读取，并防止探测写回毒化。
- 登录状态机在 kernel（ADR-010），终端渲染在 cli；登录成功后由 loader 装配业务服务。

### 事件桥

每个 Service 只注册一次原生 listener（ADR-003）：桥把回调原样 `emit` 进类型化通道，
payload 不改写；缓存维护与协议翻译各自订阅通道。

| 桥 | 原生服务 / 注册方法 | 事件前缀 |
|---|---|---|
| MsgBridge | `getMsgService` / `addKernelMsgListener` | `Msg/` |
| GroupBridge | `getGroupService` / `addKernelGroupListener` | `Group/` |
| FriendBridge | `getBuddyService` / `addKernelBuddyListener` | `Buddy/` |
| RecentContactBridge | `getRecentContactService` / `addKernelRecentContactListener` | `RecentContact/` |
| LoginBridge | 装配方注入的 loginService 实例 | `Login/` |

事件面（方法名即事件名后缀）：

- `Msg`：onRecvMsg、onRecvMsgReadReport、onRecvMsgReceipt、onMsgInfoListUpdate、
  onRecvOfflineFileMsg、onFileMsgCome、onRecvOnlineFileMsg、onRecvSysMsg。
- `Group`：onGroupListInited、onGroupListUpdate、onGroupDetailInfoChange、onMemberListChange、
  onMemberInfoChange、onGroupNotifiesUpdated、onGroupSingleScreenNotifies、
  onShutUpMemberListChanged、onGroupEssenceListChange。
- `Buddy`：onBuddyReqChange、onBuddyListChange、onBuddyListChangedV2、onBuddyDeleted。
- `RecentContact`：onRecentContactListChangedVer2、onRecentContactNotification。
- `Login`：onLoginDisConnected、onLogoutSucceed。

桥的构造期一次性取服务（getter 返回空抛 `INVALID_STATE`），`register` 幂等（已有 listenerId
直接返回），`unregister` 注销。未校准的回调参数类型保持 `unknown`，由订阅方防御性收窄。

### NTEventChannel

`NTEventChannel<L, Name>` 是事件通道（ADR-003），不继承 EventEmitter：

- 事件名由 Listener 接口方法名编译期推导为 `${Service}/${method}`，写错编译期报错。
- `on(event, handler)` 返回退订函数；`onAny` 整通道订阅（IPC 转发用）；`waitFor` 带
  filter 与超时（默认 30s），超时抛 `TIMEOUT`；`onError` 汇总订阅者异常。
- `emit` 对订阅者做快照并逐个 try/catch：单个订阅者异常不打断派发，统一走 `onError`。
- 关闭默认 10 监听器上限，允许同一 Service 挂多个订阅者（缓存 + 协议）。

### 业务 API 与错误语义

`src/apis/` 共 12 个业务模块：11 个 Api 类（msg / group / friend / group-notify / richmedia /
profile / profile-like / recent-contact / ticket / webapi / flash-transfer）+
`stranger-info` 纯映射。统一错误语义（ADR-009 / ADR-017）：

- 成功返回业务值；失败抛 `KernelError`，`code` 取 8 个枚举之一：`SEND_FAILED`、
  `PERMISSION_DENIED`、`NOT_FOUND`、`TIMEOUT`、`NOT_LOGIN`、`INVALID_PARAM`、
  `INVALID_STATE`、`UNKNOWN`。协议层只维护 `code → 协议错误码` 映射表。
- `apis/result.ts` 是唯一的解包处：`unwrap`（result 非 0 即失败）、`checkLooseResult`
  （原生返回形状宽松时用）、`unwrapResult`（按 `errMsg` 关键词映射语义码，未命中且为
  `sendMsg` 时兜底 `SEND_FAILED`）。
- `ConfigError extends KernelError`（`code` 恒 `INVALID_PARAM`）标记「配置未就绪」一族，
  CLI 与 self-host 以 `EXIT_CONFIG_INVALID = 78` 退出，与运行时崩溃区分，宿主免重启。

### 类型层来自运行时探测

`types/services/`（service 方法面）、`types/listeners/`（回调面）、`types/entities.ts`
（RawMessage / RawElement / Ptt / Video 等）来自加载 `wrapper.node` 后的运行时反射与实体
JSON 观察（ADR-006），探测代码在 `src/wrapper/probe/`。未实证字段标「待探测校准」，不得按
推测补字段；新增原生能力先补探测产物，再改类型与实现。

### 登录与快速登录超时兜底

- `quickLogin` 对 `getLoginList` 与每次 `attemptQuickLogin` 用 `raceWithTimeout` 包裹，
  默认 `QUICK_LOGIN_TIMEOUT_MS = 20_000`（`QuickLoginOptions.quickLoginTimeoutMs` 可配）。
- 超时按登录失败处理：`快速登录失败: 快速登录超时`（`NOT_LOGIN`），复用既有
  catch / 扫码回退语义；文案不含网络错误特征，不进重试循环。
- 底层 NAPI promise 无法取消，超时后悬挂丢弃，不做 removeListener/中断等清理。
- `QrLoginSession.start` 的 quickUin 路径在 `quickLoginWithUin` **之前**先 `restartTimeout()`，
  保证挂起时 120s 兜底计时存在；超时 failed 后迟到结果不得复活会话或重复出码。
- loader 软重登显式传 `quickLoginTimeoutMs: 20000`，固化口径。

### 视频发送

canonical `video`（`path`、可选 `thumbPath` / `width` / `height` / `durationSec`）经
`MsgApi.prepareVideoElement` 变成可播放的 `videoElement`：

1. `statFile` + `hashFile` 得视频 md5；`getRichMediaFilePathForGuild`（elementType 5、
   downloadType 1、needCreate）取 Ori 目标路径，`util.copyFile` 放置原文件。
2. 有缩略图时另算缩略图内容 md5（填 `thumbMd5`），但目标路径用**视频 md5** +
   缩略图扩展名（downloadType 2，落 `Thumb/<videoMd5>_0.png`）——用缩略图 md5 会让 native
   传输找不到缩略图，整条消息报 `rich media transfer failed`。
3. `thumbPath` 必须传真实 `Map<number,string>`（`new Map([[0, relPath]])`）；经 JSON/IPC
   会退化成 `{}`，wrapper 转换失败。
4. `toSendElements` 的 `video` 分支只接受已预处理元素，直接传 canonical video 抛显式错误，
   防止绕过。图片/语音复用同一 `placeMediaFile`（默认 downloadType 1）。

接收方向 `videoToCanonical` 用 `readVideoThumbPath` 容忍 `thumbPath` 的 Map / 平面对象 /
字符串三形态，并补 `width` / `height`（thumbWidth/Height）与 `durationSec`（fileTime 秒）。

### ARK 卡片接收

`elementType 10` 的 `arkElement.bytesData` 是卡片 JSON 字符串：接收方向原样透传为
`canonical {type:"json", raw}`，不解析重组（OB11 `json` 段与生态一致）；`bytesData` 缺失或
为空落 `unknown` + raw 兜底。发送方向对称：`toSendElements` 的 `json` 分支写
`{elementType: ARK, arkElement:{bytesData}}`，非字符串 `raw` 做 JSON 序列化（循环引用抛
`INVALID_PARAM`）。`xml` / `file` / `forward` 仍不支持（判别字段未探明或有专用动作）。

### listener 录制器

`probe-listener.ts` 是探测工具而非运行路径：`NAPUTO_LISTENER_RECORD=1` 时由 loader
bootstrap 在探测之前挂上 Proxy 万能监听器，把**原生实际调用的回调名**逐行写入
`NAPUTO_CFG_DIR/napuketto-listener-record.jsonl`。用途是给未接线事件补回调证据；它与业务
bridge 并存、不替代 bridge。命令、产物格式与首录观察见 [evidence.md](./evidence.md)。

### 平台参数

- `detectPlatformType()`：`process.platform` → `KLINUX` / `KMAC` / `KWINDOWS`（默认）。
- `parseQuaFromMajor()` 从 `major.node` 扫描 `V1_(WIN|LNX|MAC)_NQ_…_GW_B`；
  `resolveAppidQua()` 优先内置 qua，解析不到才用 `buildQua` 拼（Linux 用 `_` 连接版本）。
- `buildEngineConfig` / `buildSessionConfig` 接受显式 `platform` 覆盖；`use_xlog` 在非
  Windows 打开。appid 唯一来源是 `major.node` 动态解析，失败显式抛错，不回退过期值。
- `resolveQqUserDataRoot`：Linux 直接用数据根（`NAPUTO_DATA_ROOT` 或 `attachWrapper` 的
  `env.dataRoot`）；Windows 走官方 `getNTUserDataInfoConfig()` + `Tencent Files` 兜底。
  `resolveQqGlobalPath` 统一拼 `<数据根>/nt_qq/global`，不读写 `$HOME`。

### sendMessage 返回 msgId

`MsgApi.sendMessage` 用 `generateMsgUniqueId` 生成 id 塞进 `peer.guildId`、首参传 `"0"`，
再等 `Msg/onMsgInfoListUpdate` 中 `sendStatus` 为 2/3 的确认（15s 超时）。返回值取确认消息
的 `msgId`（`confirmSend` 交回命中的 `RawMessage`），缺失才回退生成值——Windows 两者一致，
Linux wrapper 落库 id 与生成值不同，必须以确认消息为准，否则 `get_msg` / `recallMsg` 查不到。

## 文件发送

服务端拒绝文件消息路线：`sendMsg` 带 `fileElement` 时原生会自己发起上传，然后返回
`{"result":-1,"errMsg":"rich media transfer failed"}`；BatchUpload / BatchTransfer 同一条
传输命令回 `170019002`，且换群号、扫遍业务参数都不变。也没有任何 NAPI 能把文件送进群文件
列表。`prepareFileElement` 因此只是预留实现，不是投递通道。

唯一可用通道是**闪传**：`FlashTransferApi` 上传文件集再发卡片。

- `uploadFileSet(paths, opts)` → `{fileSetId, shareLink, fileCount}`；完成判定靠事件计数
  （每个文件 `onFileDidFinishUpload` 按 `cliFileId` 去重 + 取到 `fileSetId`），默认 10 分钟
  超时抛 `TIMEOUT`。
- `sendCard(peer, fileSetId)` 把卡片发到群 / 私聊；`sendFile(peer, paths, opts)` 一步完成。
- 语义降级必须显式：发出的是分享链接卡片（`qfile.qq.com`），不是 `fileElement` 文件消息，
  也不进群文件列表；`file_id` 等于 `fileSetId`，不能用于群文件动作。协议文档与 adapter 已
  明示该差异，不得再引入「回查 fileUuid / 缺省 msgId」的假成功路径。

通道探测过程与原始返回见 [evidence.md](./evidence.md)。

## 已知边界

- `downloadRichMedia` 对 `transferStatus != 2`（尚未下载）样本的下载行为未实测；签名已实证，
  实现按轮询策略防御。
- `onRecvOfflineFileMsg`、`onGroupEssenceListChange`、`Buddy/onBuddyReqChange` 的 payload
  形状仍在 adapter 侧校准，未实证字段保持 `unknown`，由订阅方防御收窄。
- `msg_emoji_like` 没有推送回调；读取面是否经 `onMsgInfoListUpdate` 携带或需轮询
  `getMsgEmojiLikesList` 尚未观测。
- 群文件「列表式上传」没有原生入口；文件投递只走闪传（见上）。

## 跨包契约

- **loader 装配**：loader 动态 import kernel（`NAPUTO_KERNEL_ENTRY`），登录成功后调
  `createKernelServices`：建 5 条通道 + 桥、群/好友缓存、各 Api、自身信息；软重登前调
  `dispose()` 注销桥与缓存订阅。IPC 模式经 `forwardChannel`（通道 `onAny`）把事件转成
  IPC 消息，协议模式由 adapter 直接订阅。
- **adapter 只做三件事**：订阅事件通道、读缓存、调语义化 API。禁止触碰 `wrapper.node`、
  session、原生 service，也禁止自己注册原生 listener（AGENTS.md 红线 3）。协议翻译是纯函数，
  可单测（ADR-008）。
- **错误传播**：kernel 抛 `KernelError`；adapter 只做 `code → 协议码` 映射，不解析原生
  `{result, errMsg}`。事件链路异常经通道 `onError` 上报，不向原生回调抛出。
- **类型与配置**：adapter 可 import kernel 的实体/枚举类型；配置由 kernel `ConfigBase` 读写，
  boot 以账号协议段作 seed。`ConfigError`（退出码 78）是进程级契约，不映射成协议错误。
- **依赖方向**：kernel 无内部依赖，不 import adapter / network / media / loader；媒体能力
  只在 adapter 侧使用（ADR-011）。

## 关键取舍与不变量

- **无全局单例**（ADR-015 推论）：logger / cache / event-channel / Api 都由装配层实例化，
  每进程一份；改代码不得引入模块级可变单例。
- **错误分类只做一次**（ADR-009）：原生结果只在 `apis/result.ts` 解包，其他层不得重复判断
  `result` / `errMsg`。
- **翻译纯函数、缓存只读**（ADR-008）：协议层不得在翻译过程中调 API 或写缓存；缓存由事件
  主动维护、查询惰性回填。
- **类型层只来自运行时探测**：未实证字段保持 `待探测校准`，不得凭猜测补字段或改枚举值。
- **探测产物增量落盘**：探测与录制产物写 `NAPUTO_CFG_DIR`，可中途崩溃后定位；公共文档只写
  符号名与方法名，不写逆向地址。
- **桥只透传**：不得在原生回调里做重活或改写 payload；耗时逻辑订阅通道后异步处理。
- **登录悬挂即丢弃**：超时只做失败语义，不尝试取消底层 promise。
- **文件发送不造假成功**：只能走闪传；语义降级必须写在协议文档，不得用 `sendStatus=0`
  静默失败。

历史决策见 [decisions.md](../../../docs/architecture/decisions.md)，实测样本与探针命令见
[evidence.md](./evidence.md)。
