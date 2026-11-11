# @napuketto/kernel 设计书（2026-09-08 首版：覆盖 bridge/event-channel/apis 模块）

> 本包是唯一原生交互层（AGENTS.md 红线 3）：只有 kernel 允许 `process.dlopen`、
> 访问 `wrapper.node`、注册原生 listener。其他包只调语义化 API / 订阅事件通道 /
> 读缓存。无全局单例（ADR-015 推论）：logger/cache/event-channel 均实例化，
> 由 `CoreContext` 持有。本文覆盖 2026-09-08 接线轮次动到的模块；wrapper 加载 /
> login / paths / config 等既有模块详见源码头注释与 `docs/architecture/overview.md`。

## 1. 事件桥（bridge/）

三座桥（Msg/Group/Friend），同构模式：

| 桥 | 原生服务 | listener 注册 | 通道类型 | 事件（`${Service}/${method}`） |
|---|---|---|---|---|
| MsgBridge | getMsgService | addKernelMsgListener | `NTEventChannel<MsgListener, "Msg">` | onRecvMsg / onRecvMsgReadReport / onRecvMsgReceipt / onMsgInfoListUpdate + **onRecvOfflineFileMsg / onRecvOnlineFileMsg / onRecvSysMsg（c3，2026-09-10）** |
| GroupBridge | getGroupService | addKernelGroupListener | `NTEventChannel<GroupListener, "Group">` | onGroupListInited / onGroupListUpdate / onGroupDetailInfoChange / onMemberListChange / onMemberInfoChange / onGroupNotifiesUpdated / onGroupSingleScreenNotifies / onShutUpMemberListChanged + **onGroupEssenceListChange（c3，2026-09-10）** |
| FriendBridge（2026-09-08 新增） | getBuddyService | addKernelBuddyListener | `NTEventChannel<BuddyListener, "Buddy">` | onBuddyReqChange / onBuddyListChange / onBuddyListChangedV2 / onBuddyDeleted |

- 桥只做透传：原生回调参数原样 emit 进通道（payload 不改写）。
- register/unregister 幂等（listenerId 判空）。
- **FriendBridge 方法名证据**：wrapper.node（9.9.33-52230）二进制字符串提取
  （`grep -aoE "onBuddy[A-Za-z0-9]+" wrapper.node | sort -u`），与 Group/Msg
  listener 已知名交叉验证可靠。**回调参数形状未经真实事件校准**（listener
  类型参数一律 unknown，订阅方防御性收窄 + raw 日志积累校准数据）。

### c3 新接线（2026-09-10，五无源 notice 事件探测轮）

证据方法：`scripts/probe-scan-strings.mjs` 流式扫描 wrapper.node（ASCII +
UTF-16LE 双通道，产物 `$TEMP/napuketto-probe/strings-scan.json`）；强弱判定
标尺 = ① 小写 `onXxx` 名与已知 listener 名的**偏移同簇性**（linker 把 NAPI
反射回调名排进同一字符串表页，如 onRecvSysMsg 距 onRecvMsg 仅 1.4KB、
onGroupEssenceListChange 夹在 onMemberListChange 与 onBuddyReqChange 之间）
② RTTI 装饰名（`OnRecvOfflineFileMsg@KernelMsgService@wrapper@nt`）③ argc
断言字符串。动态验证：`scripts/probe-notice-sources.mjs`（IPC 宿主 + 90s
事件观测窗，产物 `$TEMP/napuketto-probe/notice-sources.json`）。

| 事件 | 结论 | 证据 |
|---|---|---|
| offline_file | **源 = Msg/onRecvOfflineFileMsg**（强） | RTTI 硬证据 + 偏移同簇（距 onRecvMsg ~7KB）+ API 族 getNewOfflineFileList（实测 `{}` 单参可调，返回 `[]`）；payload 形状待真实事件校准 |
| group_card / group_title / group_sign | **载体 = Msg/onRecvSysMsg（sys msg 总闸，已接线）** | 二进制 55 个 `OnSysMsg*` 处理器（含 ModifyGroupMemberInfo / ModifyGroupMemberSpecialTitle）；checkin 数据在群资料字段（checkin_status/checkin_cnt）。**运行时实触**：90s 窗口 2 次，payload = **原始 protobuf 字节**（int8 数组，内嵌 uid 可见）——type/subType 在 protobuf 内，解码器是下轮翻译前置 |
| msg_emoji_like | **无推送回调**（API 面存在） | 无 on\* 回调名；API：setMsgEmojiLikes(5 参) / getMsgEmojiLikesList(7 参) + djinni 单次回调接口（NodeISetMsgEmojiLikesCallback）。疑经 onMsgInfoListUpdate 携带或需轮询，待观测 |
| （清单外）group_essence | 源 = Group/onGroupEssenceListChange（已接线，强） | 偏移夹在两个已知名之间 + API 族 addGroupEssence/getGroupLatestEssenceList；payload 待校准 |
| （清单外）poke / honor / typing | 观测候选 | wrapper 层 sendNudge/recallNudge（poke API）；onGroupDragonListChange（龙王）；sendShowInputStatusReq + onInputStatusPush（typing，走 sysmsg：ProcessInputStateNotifySysMsg） |

**附**：registerSysMsgNotification / unregisterSysMsgNotification 存在于
msgService（`needs 3 arguments`，mangled 签名 `(int, int64, vector<int64>,
shared_ptr<IOperateCallback>)`）——按 type/subType 订阅 sysmsg 的**请求式**
注册（回调对象经 IPC JSON 协议无法传递，diag 面不可测；listener 推送已够用，
列为备选机制）。onRecvMsgReadReport / onRecvMsgReceipt 在本二进制无字符串
痕迹（疑版本差异死接线，无害——listener 多余方法被忽略）。

### 装配（loader 侧 kernel-services.ts）

登录成功后 `createKernelServices`：每座桥 `new NTEventChannel(<Service>)` +
`new XxxBridge(session, channel)` + `register()`。进程级存活（无 dispose 路径，
与进程生命周期一致）。IPC 模式下三条通道均经 `forwardChannel`（onAny）转发为
IPC event 消息（koishi 插件消费）；协议模式由 adapter 订阅。

## 2. 事件通道（event-channel.ts）

`NTEventChannel<L, Name>`：EventEmitter 封装，事件名从 Listener 接口方法名
编译期推导（ADR-003）。`on(event, handler)` 返回退订函数；`onAny` 全事件订阅
（IPC 转发用）；`waitFor` 带过滤/超时；订阅者异常不打断派发（onError 上报）。

## 3. apis/（12 个，统一错误语义 ADR-009）

infra 层错误契约（2026-10-25 嵌入式退出码）：`ConfigError extends KernelError`
（`code` 恒 `INVALID_PARAM`，`name` 恒 `ConfigError`）标记「配置未就绪」一族——
`ConfigBase` 的反序列化/校验失败与 cli `parseCliConfig` 全部校验错误；CLI 与
self-host 据此以 78（EX_CONFIG）退出，与运行时崩溃（非 0 非 78）区分，宿主免重启。
`ConfigBase.parseText(raw)` 提供只读的"反序列化+校验"（`config validate` 用，
不落模板），错误包装与 `load()`/`save()` 逐字一致。

成功返业务值 / 失败抛 `KernelError`（类型化错误码，协议层映射表消费）。
本次接线相关：

- **friend.ts**：`getBuddyReqList()`（getBuddyReq → buddyReqs）；
  `handleFriendRequest(notify, accept)`（approvalFriendRequest）。
  OB11 `set_friend_add_request` 的 flag = `BuddyReq.reqTime`（拉取匹配）。
- **group-notify.ts**：`getSingleScreenNotifies(doubt, count)` /
  `handleGroupRequest`。OB11 `set_group_add_request` 的 flag = `GroupNotify.seq`。
- **msg.ts**：`fetchMsgsByMsgId(peer, ids)`（get_image/get_record 反查）、
  `placeMediaFile`（发送侧按 QQ 原生契约放置：getRichMediaFilePathForGuild +
  util.copyFile）。
- **richmedia.ts**：群文件系列（getGroupFileList 等）。**注意**：原生
  `downloadRichMedia` 方法存在于 wrapper（字符串证据），但签名未探测——
  收方向语音/图片主动下载的原生路径待实测后接入（当前 adapter 侧用
  picUrl + HTTP 下载兜底，见 adapter design.md）。

## 4. 类型层来源（ADR-006）

`types/listeners/`（msg/group/buddy）+ `types/services/`（运行时反射面）+
`types/entities.ts`（RawMessage/GrayTip/Pic/Ptt 等）。类型来自运行时探测 +
wrapper 二进制字符串证据；未实证的字段标「待探测校准」注释。探测脚本在
`src/wrapper/probe/`（probe.ts 入口）。

## 5. downloadRichMedia 探测产物（2026-09-08 B1 实测，QQ 9.9.33-52230）

探测方式：`scripts/probe-download-richmedia.mjs`（IPC 宿主 + diag.msgServiceCall /
diag.richMediaCall；产物全文 `$TEMP/napuketto-probe/artifacts.json`）。

### 5.1 方法面（运行时 `__methods` 枚举）

- **NodeIKernelMsgService** 有 `downloadRichMedia` / `getRichMediaElement` /
  `getLatestDbMsgs` / `getMsgsByMsgId`（`getMsgs` 需 4 参：peer, msgId, count, false——
  fetchMessages 现有路径）。
- **NodeIKernelRichMediaService** **无** 裸 `downloadRichMedia`，只有
  `downloadRichMediaInVisit` + downloadFile 族（downloadFileForFileUuid /
  downloadFileByUrl / downloadFileForFileInfo / downloadFile / onlyDownloadFile 等）。

### 5.2 downloadRichMedia 签名（实测）

```ts
// NodeIKernelMsgService（单参数对象；二进制 assertion "needs 1 arguments"）
downloadRichMedia(param: {
    msgId: string;       // 消息 ID（msgId 字符串）
    elemId: string;      // 元素 ID（elementId 字符串）
    chatType: number;    // 2=群 1=C2C
    downloadType: number;// 2 实测可用
    thumbSize: number;   // 0
}): Promise<void>        // ⚠️ resolve undefined——下载结果不从返回值拿
```

- 返回 void：下载完成信号只能经**重拉消息元素**（transferStatus/filePath）或事件观察。
- 参数残缺（msgId/elemId undefined）时**不抛错**（内部静默 no-op）——调用方必须自证参数完整。
- `richMediaService.downloadRichMediaInVisit` 同款参数抛
  `Cannot convert undefined or null to object`（需额外未知字段，未深挖——MsgService 版已够用）。

### 5.5 downloadRichMediaInVisit 完整参数面（c3 深挖，2026-09-10 实测破案）

静态证据（字符串）：`NodeIKernelRichMediaService::downloadRichMediaInVisit
needs 1 arguments`（单对象参数）；InVisit 族日志 `GetVideoPlayUrlInVisit Fail
Param Invalid elem = null, msgid=[{}] elemid=[{}] peer_uid=[{}] chattype=[{}]`
提示参数含 **elem 元素对象**。动态实测（scripts/probe-notice-sources.mjs，
真实 pic 元素）：base 四变体（+elemType/triggerType/peerUid）全抛 `Cannot
convert undefined or null to object`；**加 `elem` 字段后 ok:true**（完整元素
对象与纯 picElement 均可）。完整签名：

```ts
// NodeIKernelRichMediaService（单参数对象）
downloadRichMediaInVisit(param: {
    msgId: string;
    elemId: string;
    chatType: number;
    downloadType: number; // 2
    thumbSize: number;    // 0
    elem: object;         // ⚠️ 关键差异：需传入元素对象（完整 element 或媒体子对象均可）
}): Promise<unknown>      // 实测调用成功；返回值未观察（MsgService 版已够用，不替换）
```

### 5.3 行为实测（挪文件实验）

- `pttElement.filePath` 收向为**绝对路径**（`…\nt_qq\nt_data\Ptt\2026-08\Ori\<md5>.ogg`），
  本地命中时 `existsSync(filePath)` 直接可用。
- `transferStatus` 实测样本：**4 = 自己发送（已上传）**、**2 = 收到（数据库标记已下载）**。
- **transferStatus=2 时调 downloadRichMedia 不重新落盘**（把本地文件挪走后调用，
  12s 轮询文件不回来、transferStatus 恒 2）——wrapper 以数据库状态为准，不查磁盘。
  结论：downloadRichMedia 的有效场景 = transferStatus ≠ 2 的未下载消息（如清理过
  缓存后重收/其他端的消息）；已下载但磁盘缺失的场景无法用此方法恢复。
- kernel 实现策略（apis/msg.ts `downloadPtt`）：调用后**轮询 getMsgsByMsgId**
  （300ms 间隔，总超时 10s）直到 pttElement.filePath 存在且磁盘命中，超时回退
  （由 adapter 层回退原始路径 + 元数据）。

### 5.4 PttElement 完整字段（实测快照，2026-09-08）

收向全字段（历史消息 getLatestDbMsgs 提取，比既有类型多出斜体字段）：
fileName / filePath / md5HexStr / fileSize / duration / formatType / voiceType /
autoConvertText / voiceChangeType / canConvert2Text / fileId / fileUuid / text /
translateStatus / *transferStatus* / *progress* / *playState* / waveAmplitudes /
*invalidState* / fileSubId / *fileBizId* / *import_rich_media_context* / storeID /
otherBusinessInfo{aiVoiceInfo, aiVoiceType} / *isInApplicationDataPath*。
（斜体 = 本轮补进 types/entities.ts 的字段。）

## 6. 已知缺口（下一轮）

- ~~onRecvSysMsg payload = 原始 protobuf 字节，解码器是下轮翻译前置~~ **已收口（2026-09-10）**：
  解码器落地在 adapter 侧（`helper/sysmsg.ts`，wire-format 手写解码 + 信封提取 + 识别层，
  详见 adapter design.md §7）；识别表 KIND_TABLE 当前为空，等 card/title/sign 真实样本
  登记规则后才开始广播，kernel 侧无待办。
- onRecvOfflineFileMsg / onGroupEssenceListChange payload 形状待真实事件
  校准（adapter 侧 raw 校准日志已挂，loader.log 积累中）。
- onBuddyReqChange payload 形状（BuddyReq 字段 words 等待真实事件校准）。
- poke 的 aioOpGrayTipElement 完整字段（adapter 侧翻译待校准）。
- msg_emoji_like 无推送回调：疑经 onMsgInfoListUpdate 携带或轮询
  getMsgEmojiLikesList（7 参），待观测。
- downloadRichMedia 对 transferStatus≠2 消息的真实下载行为（本机所有样本已下载，
  无法自然构造未下载样本——签名已实证，行为按轮询策略防御）。
- **文件发送**：通道已探明（BDH / BatchUpload / BatchTransfer / FlashTransfer，见 §14、§15）。
  文件**消息**路线被服务端传输命令拒（`170019002`，与业务参数无关，§15.3/§15.4），
  `prepareFileElement` 仍是预留实现；**闪传**（上传文件集 + 分享卡片）已实测可用（§15.5），
  待接成对外动作。

## 7. 登录域：快速登录超时兜底（T3，2026-09-10）

**缺陷**（软重登挂起，2026-09 审计确认）：服务端已有同账号会话时，底层
`quickLoginWithUin` / `getLoginList` NAPI promise **永不 settle**。此前裸 await：

- `quickLogin`（login-connect.ts）挂起 → `NapukettoCore.login` 的
  catch/qrFallback 永不触发（promise 不 reject，catch 无从谈起）。
- `QrLoginSession.start` quickUin 路径挂起 → `refresh()` 不执行，而 120s 超时
  定时器只在 `refresh()` 里启动——挂起时连兜底计时都不存在。
- loader control login 挂起 → `.finally` 的 `control.release()` 不执行，
  登录互斥永不释放，面板无任何反馈。

**设计**：超时竞速 + 失败语义复用，不引入取消机制。

- `quickLogin`（login-connect.ts）：`QUICK_LOGIN_TIMEOUT_MS = 20s` 默认，
  `QuickLoginOptions.quickLoginTimeoutMs` 可配；`getLoginList` 与每次
  `attemptQuickLogin` 经 `raceWithTimeout` 包裹，超时按登录失败处理
  （`快速登录失败: 快速登录超时`，NOT_LOGIN）→ 现有 catch/qrFallback 语义
  自动生效。**超时文案不含网络错误特征**（非 1006511/连接异常）→ 不进重试
  循环（避免 3 次重试 × 20s 叠挂 60s+）。
- **悬挂丢弃原则**：底层 NAPI promise 无法取消，超时后原 promise 悬挂
  丢弃（race 败者的迟到 settle 由 race 内部吞掉）——不做任何清理动作
  （removeListener/中断底层），避免二次问题。
- `QrLoginSession.start`（login.ts）：quickUin 路径在 `quickLoginWithUin`
  **之前**先 `restartTimeout()`（挂起 → 120s 超时 failed）；失败/异常路径
  维持 refresh 回退，但仅限 idle 态（`refreshAfterQuickLogin`）——超时 failed
  后悬挂 promise 的迟到结果不得复活会话/重复出码。
- 透传链：`CoreLoginOptions.quickLoginTimeoutMs` → `quickLogin`；loader
  relogin.ts 显式传 20000（与 initTimeoutMs 同值，固化软重登口径）。
- 已知边界：登录期（login-race 相位）的快速登录挂起本就有抢占口兜底
  （T2），本机制与其正交——抢占后悬挂 promise 照旧丢弃。

## 8. 视频发送（VIDEO 元素，2026-10-17）

**目标**：协议层 `h.video(...)` / OneBot `video` 段 → canonical video → kernel
`prepareVideoElement` → `sendMsg` 发出**可播放的视频消息**（不是文本、不是文件）。

### 8.1 canonical 元素

```ts
| { type: "video"; path: string; url?: string; thumbPath?: string;
    width?: number; height?: number; durationSec?: number }
```

- `path`：本地视频文件路径（adapter 负责把 data URL / http(s) URL 落盘成临时文件）。
- `thumbPath`（可选）：缩略图**本地**路径（adapter 用 `@napuketto/media` 的
  `extractVideoFrame` 抽首帧生成；kernel 不生成、不 import media——红线 6）。
- `width`/`height`：**视频**宽高（收向实测 `thumbWidth`/`thumbHeight` 与视频一致）。
- `durationSec`：整数秒（由 ffprobe 得出，向上取整保底 1）。

收向 `videoToCanonical` 同步补全：`thumbPath`（`readVideoThumbPath` 防御读取，
见 8.3 备注）、`width`/`height`（`thumbWidth`/`thumbHeight`）、`durationSec`
（`fileTime`，单位秒）——发送/接收共用同一 canonical 形状。

### 8.2 发送流程（`MsgApi.prepareVideoElement`）

1. `statFile` + `hashFile`（md5 十六进制小写）；
2. `getRichMediaFilePathForGuild({ md5HexStr, fileName, elementType: 5,
   elementSubType: 0, thumbSize: 0, needCreate: true, downloadType: 1,
   file_uuid: "" })` → `Video/<YYYY-MM>/Ori/<md5>.<ext>`；
3. `util.copyFile(path, targetPath)` 放置原文件；
4. 缩略图（有 `thumbPath` 时）：`statFile`/`hashFile` 取缩略图内容 md5，
   **但目标路径用视频 md5**：`downloadType: 2` → `Video/<YYYY-MM>/Thumb/<videoMd5>_0.png`，
   `util.copyFile` 放置；
5. 组装完整 `videoElement`（见 8.3），`thumbPath` 用 **真实 `Map<number,string>`
   `new Map([[0, thumbRelPath]])`**——经 JSON/IPC 会退化成 `{}`，wrapper 转换失败；
6. `prepareSendElements` 用该元素替换 canonical video，其余走 `toSendElements`
   （`toSendElements` 的 `video` 分支改为抛「需经预处理」的显式错误，防止绕过）。

`placeMediaFile` 增加 `downloadType` 参数（默认 1），PIC/PTT 行为不变。

### 8.3 videoElement 字段契约（收向实测 + 发送探测）

| 字段 | 值 | 来源 |
|---|---|---|
| `fileName` | 视频文件名（basename） | 收向实测 |
| `filePath` | 步骤 2 的目标路径（绝对，Ori） | 收向实测 |
| `fileSize` | 文件字节数（**字符串**） | 收向实测 |
| `videoMd5` | 视频 md5（小写十六进制） | 收向实测 |
| `fileTime` | 时长（**秒**） | 收向实测 |
| `fileFormat` | `0` | 收向实测（0/1 均出现过，发送取 0） |
| `busiType` / `subBusiType` | `0` | 收向实测 |
| `storeID` | `1` | 收向实测 |
| `original` | `true` | 收向实测（true/false 均出现） |
| `videoFrom` | `0` | 收向实测 |
| `sourceVideoCodecFormat` | `0` | 收向实测（0/1 均出现） |
| `fileUuid` / `fileSubId` | `""` | 收向实测 |
| `thumbMd5` / `thumbSize` | 缩略图内容 md5 / 字节数 | 收向实测 |
| `thumbWidth` / `thumbHeight` | canonical `width`/`height` | 收向实测 |
| `thumbPath` | `Map<0, 缩略图路径>`，路径文件名用**视频 md5**（`Thumb/<videoMd5>_0.png`） | 收向实测（**Map 非字符串**） |

收向实测样本还携带 `transferStatus/progress/invalidState/fileBizId/
originVideoMd5/import_rich_media_context/isInApplicationDataPath`（下载态字段），
发送时不填——由 wrapper 传输流程自行维护。

**thumbPath 接收形态（2026-10-24 线上事故后定稿）**：进程内收向为
`Map<0, path>`（上表）；但经 JSON 序列化（koishi IPC 行协议等）跨进程后，
`JSON.stringify(Map)` 内容全丢——loader 侧会规整成平面对象 `{"0": path}`，
未规整的旧链路则退化为空对象 `{}`。因此**接收读取一律走
`message-element.ts` 的 `readVideoThumbPath`**（Map / 平面对象 / 字符串三形态
均容忍，`VideoElement.thumbPath` 类型同步放宽为三者联合）；发送侧仍是
8.2 步骤 5 的真实 Map 契约，不变。

### 8.4 发送链路已打通（2026-10-17 实测）

**根因（关键）**：缩略图目标路径必须用**视频 md5** 计算，不能用缩略图内容 md5。

真实视频消息实测（用户手机 QQ 发出的 18s/2.5MB 竖屏视频）：

- `videoMd5 = 3d27c01ecb7cf9f6c952ee587f8cfc3f`
- `thumbMd5 = 46daaa71ff0e5deac591ac32d6a7002c`（= 缩略图文件内容 md5，实测比对一致）
- 实际落盘缩略图：`Video/2026-10/Thumb/3d27c01ecb7cf9f6c952ee587f8cfc3f_0.png`
  ——文件名是**视频 md5**，不是 `46da…`

此前实现按 `thumbMd5` 调 `getRichMediaFilePathForGuild(downloadType=2)`，缩略图被放到
`Thumb/<thumbMd5>_0.png`；native 传输按视频 md5 推导缩略图路径（对应二进制里的
`move orig as thumb failed` / `combine video and it's thumb failed`），找不到即整体
`rich media transfer failed`——这正是 20+ 组字段/路径变体全部失败的原因（字段本身
一直是对的）。

**修复**：`prepareVideoElement` 用视频 md5 + 缩略图扩展名构造缩略图目标路径
（`placeMediaFile(..., md5, `${md5}.png`, downloadType=2)`），`thumbMd5` 仍填缩略图
内容 md5。

**验证**：2026-10-17 18:12 自建宿主（QQ 9.9.33-52230）`MsgApi.sendMessage` 发
canonical video（`test3.mp4` 640×360 10s + `test3.png` 缩略图），返回
`{ msgId: "7771794519560903400" }`（sendStatus 2/3 确认通过），**群内收到可播放
视频**（用户目视确认）；落盘 `Ori/e54a…mp4`（md5 一致）+ `Thumb/e54a…_0.png`
（内容 md5 `e182…`，与 `thumbMd5` 一致）。

**回归**：图片/语音/文本路径未改动（仅 `placeMediaFile` 增加默认 `downloadType=1`
参数、`prepareSendElements` 增加 video 分支）；kernel 全量 242 用例、koishi 插件
244 用例、`pnpm check`、`pnpm -r build` 均通过。


## 9. ARK 卡片接收（小程序/分享卡片，2026-10-25）

**背景**：B 站分享等 QQ 小程序卡片在 NT 侧是 `elementType: 10 (ARK)` 元素
（`arkElement.bytesData` 装卡片 JSON 字符串）。此前 `toCanonicalElement` 的
switch 只认 TEXT/PIC/FACE/PTT/VIDEO/FILE/REPLY 七类，ARK 落 `unknown` 兜底：
OB11 侧 `canonicalToSegment` 映射表无 `unknown` 键整段静默丢弃（纯卡片消息
message 数组为空），koishi 侧渲染 `[unknown]` 占位（2026-10-25 线上实测）。

**方案**：`toCanonicalElement` 加 `case ElementType.ARK` → canonical
`{ type: "json", raw: bytesData }`——卡片 JSON 字符串**原样透传**，不解析重组
（OB11 `json` 段 `data.data` 保持原始载荷，与 go-cqhttp/NapCat 生态一致，
title/url 由下游自行 parse；adapter 侧 `rawToString` 对字符串原样放行，映射
早已就绪，kernel 是唯一断点）。`bytesData` 缺失/为空时维持 `unknown` 兜底
（无 payload 可表达，保留 raw 供探测）。

**契约**：`RawElement.arkElement?: { bytesData: string }`——wrapper 事实接口的
最小自研描述（2026-10-25 B 站小程序卡片实测），其余字段待真实样本探测后补。

**发送方向（2026-10-28）**：`toSendElements` 加 `case "json"` → 发送元素
`{ elementType: ARK, arkElement: { bytesData } }`，与接收方向对称。
bytesData 来源：canonical json.raw 为字符串时原样透传（OB11 `send_msg` json 段
与 satori 发送链给的已是卡片 JSON 文本），其余值 JSON 序列化（循环引用抛
KernelError INVALID_PARAM）。字段名与接收侧同源（同一 wrapper 事实）；发送
失败走 KernelError 语义。`xml` / `file` / `forward` 仍不支持（判别字段未探测 /
有专用动作）。

**其余仍落 unknown 的元素类型**（GRAY_TIP 8 / MFACE 11 / LIVE_GIFT 12 /
STRUCT_LONG_MSG 13 / MARKDOWN 14 / GIPHY 15 / INLINE_KEYBOARD 17 等）待有
真实样本按「运行时探测」原则（ADR-006）逐个补。

## 10. listener 录制器（probe-listener.ts，2026-10-31 批次三前置）

**动机**：无源事件（Milky 批次三，`docs/protocols/milky.md` §0.8）缺的不是
方法名而是**回调证据**——现有 bridge 只注册已知回调名（Msg 7 / Group 9），
原生 listener 回调面之外的派发行为从未被观测。录制器用 Proxy 万能监听器把
这块补上：原生调什么记什么。

**原理**：原生 listener 是普通 JS 对象 + NAPI 按名反射回调（§1 bridge 模式）。
`createRecordingListener(service, onEvent)` 返回 Proxy 包裹的空对象——
`get` 陷阱对任意字符串属性返回记录函数（同时记录原生查过的名字，即使从未
调用）；`has` / `ownKeys` 也记录（判定原生按名 Get 还是枚举发现回调）；
非字符串键（Symbol）放行默认行为。记录函数只序列化入参后回调 onEvent，
**绝不反向调用原生**（probe 工具安全边界）。

**接缝**：`startListenerRecording(ctx, file?)` 由 loader bootstrap 调用
（`NAPUTO_LISTENER_RECORD=1`，位置在 `runProbePhase` **之前**——session 就绪 +
协议装配完成后）。时序硬约束：probe 内 `getMainSession` 的写回副作用会把空壳
主 session 毒化进 `ctx.session`（session-resolver.ts），录制器必须先于探测取
服务。仪器面默认十个 session 服务（Msg / Group / RecentContact / BdhUpload /
OnlineStatus / Lock / FileAssistant / Buddy / ProfileLike / NodeMisc）+
LoginService（`NodeIKernelLoginService.get()`）。add/remove 方法按
`/^add(Kernel)?\w*Listener$/`（remove 同理）自动选取，覆盖裸 `addListener`
服务（VasGroup / PublicAccount）。

**产物**：`NAPUTO_CFG_DIR/napuketto-listener-record.jsonl`，JSONL 追加——
每回调一行 `{ts, service, event, args}`（probe-serialize 截断）；注册过程逐行
落盘（`<registered>`，含 listenerId），注册逐服务即时 append，原生崩溃时保留
断点定位肇事服务（同 collectServiceGetters 增量落盘惯例）。

**共存与失效**：与业务 bridge 并存——`addKernelXListener` 多监听各自独立 id，
录制器不干扰协议链路。软重登后录制器随旧 session 失效（probe 工具不随装配
重挂），重录须重启进程。回调若需返回值（原生用返回值控制流程的场合）记录
函数返回 undefined——QQ NT listener 族以 void 通知为主，首轮数据校验此假设。

**已知风险**：若原生以 ownKeys 枚举发现回调（而非按名 Get），空目标 Proxy
一无所获——`<ownKeys>` 陷阱记录会立即暴露该行为，fallback 是预置已知回调名
全集为真实属性后重新录制。

**首录实测（2026-11-01，uin 3567141148，约 4 分钟窗口）**：11 服务全部挂上；
原生按名 Get 反射确认（全程无 has/ownKeys 陷阱触发）。暴露并修复 add 方法
选择 bug：MsgService 有 5 个 add*Listener，正则按字母序误选 ImportTool（真
listener 没挂上、Msg 回调面零捕获）→ 精确名 `addKernel<简称>Listener` 优先、
回退正则。首推噪声：Buddy 注册即全量首推；每条群记录伴生 chatType=7 影子
条目（peerUid 空）。事件侧结论详见 `docs/protocols/milky.md` §0.8.5。

### 10.1 录制驱动的桥扩展（2026-11-01，批次三）

三轮录制 + 置顶自触发实验（set_peer_pin 翻转）取齐事件源证据后，按
`docs/protocols/milky.md` §0.8.6 方案扩桥：

- **RecentContactBridge**（新）：`addKernelRecentContactListener` 注册，
  转发 `onRecentContactListChangedVer2`（onRecentContactListChangedVer2 参数 =
  `{listType, sortedContactList, changedList}` 数组，changedList 条目实测含
  chatType / peerUin / topFlag / topFlagTime）与 `onRecentContactNotification`
  （RecentContact 快照数组，peer_pin 翻译不用但通道保留）。事件名
  `RecentContact/*`。
- **LoginBridge**（新）：loginService 由装配方注入（`ctx.wrapper.loginService`，
  wrapper-loader 拦截 new 捕获 / 单例 get() 兜底的既有实例，与 QrLoginSession
  同源），转发 `onLoginDisConnected` / `onLogoutSucceed`（bot_offline 候选，
  参数形状零样本透传 unknown）。事件名 `Login/*`。
- **MsgBridge** 补转发 `onFileMsgCome`：三轮录制实证与 onRecvOfflineFileMsg
  同载荷（RawMessage 数组，chatType=1 fileElement），friend_file_upload 第二
  源；`onRecvOfflineFileMsg` 参数类型同步从 unknown 收窄为 RawMessage[]。
- 类型面：`types/listeners/recent-contact.ts` 新建（RecentContactListener +
  RecentContactListChanged，录制实证形状）；`NodeIKernelRecentContactService`
  补 add/removeKernelRecentContactListener；FileElement 补录制实证字段
  （file10MMd5 / fileSha / fileSha3 / expireTime / transferStatus /
  subElementType）；RawMessage 补 sendType（0=收到 2=自己发出）；PinnedContact
  补 peerUin（peer_pin 播种键）。

桥仍是「每 Service 每进程一份、构造期一次性取服务」模式（ADR-003/015）；登录
后 getter 重挂 null 的雷区不影响——服务实例在装配期已持有。

## 11. 平台参数（Linux 原生宿主，2026-11-09 Stage 1）

- `detectPlatformType()`：`process.platform` → `KLINUX` / `KMAC` / `KWINDOWS`（默认）。
- `parseQuaFromMajor()`：从 `major.node` 扫描 `V1_(WIN|LNX|MAC)_NQ_..._GW_B`；`resolveAppidQua()`
  优先内置 qua，解析不到才按平台拼（Linux 用 `_` 连接版本与构建号）。
- `buildEngineConfig()` / `buildSessionConfig()` 接受显式 `platform` 覆盖；缺省按平台探测，
  `rdeliveryConfig.platform` 同步。
- `defaultEngineConfig()`（真启动路径）：平台探测 + `NAPUTO_WRAPPER_PATH` 同目录
  `major.node` 扫 qua + `os.version()`；Linux 打开 `use_xlog`。Windows 旧行为（qua 空）
  只在拿不到版本/major 时保底。
- 只改平台字段与 qua 来源，不动登录/会话流程；Windows 仍走 PE stub。
- **QQ 数据根按平台分流**（2026-11-09 Stage 1 E2E 修正）：`resolveQqUserDataRoot(exports, { dataRoot })`
  Windows 保持 `getNTUserDataInfoConfig()` → `$HOME/Documents/Tencent Files` 兜底；Linux
  （`KLINUX`）直接返回数据根，QQ 数据固定落 `<数据根>/nt_qq`。`commonPath` 与
  `desktopGlobalPath` 同源（`resolveQqGlobalPath`），不再读写 `$HOME`——否则换机器/换用户
  读不到历史账号，还会污染用户主目录。
- 数据根来源：`attachWrapper` 的 `env.dataRoot`（loader 由 `NAPUTO_DATA_ROOT` 注入）；
  直连/裸脚本场景回退 `NAPUTO_DATA_ROOT` 环境变量；两者都缺才回落 QQ 官方 API。
  Linux 想复用已有 QQ 数据时把 `nt_qq` 拷到数据根（不提供隐式 `$HOME` 复用）。

## 12. sendMessage 返回的 msgId（Linux 原生宿主 E2E 修正，2026-11-09）

**现象**：Linux 原生宿主下 `OneBot send_msg` 返回的 `message_id` 无法用于
`get_msg` / `delete_msg`——前者报「消息不存在或已被撤回」，后者 `recallMsg` 失败；
同一条消息走 `get_group_msg_history` 拿到的是另一个 `message_id`（内容、时间一致）。

**根因**：`MsgApi.sendMessage` 自己 `generateMsgUniqueId()` 生成 msgId，按 NapCat 式
把它塞进 `peer.guildId` 再 `sendMsg("0", ...)`；确认监听按 `m.guildId === msgId` 命中
（所以发送成功判定没问题）。但 Linux wrapper 实际落库的消息 `msgId` 是它自己另生成的
一个 id——**生成的 id 只活在 `guildId` 字段上**，拿它 `getMsgsByMsgId` / `recallMsg`
自然查不到。Windows 侧实测两者一致（§8 的 `7771794519560903400` 可直接用），故该缺陷
直到 Linux E2E 才暴露。

**修复**：`confirmSend` 不再只 resolve 成功信号，而是把命中的那条 `RawMessage`
交回；`sendMessage` 优先返回 `confirmed.msgId`（非空字符串），缺失时回退生成的 id。
语义仍是「发送确认后返回可用的 NT msgId」，Windows 行为不变（两者相同）。

**验证**：WSL Ubuntu 24.04 + Linux QQ 3.2.35 / QQNT 9.9.37，真 CLI 经 OneBot HTTP：
`send_msg` → `message_id:1`，`get_msg(1)` 返回原文，`delete_msg(1)` 成功，随后
`get_group_msg_history` 里同一条消息 `message_id` 仍为 1、内容已清空（撤回墓碑）。
修复前同流程为 1（发送）/ 2（历史）两个 id。

## 13. PIC 元素的跨平台字段差异（Linux 原生宿主，2026-11-10）

**现象**：Linux 入站图片消息的 canonical `image.path` 为空（OB11 图片段 `file: ""`，
下游无法渲染/下载），Windows 同一条消息正常。

**根因**：`picToCanonical` 取 `picPath ?? picUrl`，但 Linux 3.2.35 的 `picElement`
**两个字段都不存在**（不是空串，是根本不给），实际形状（真机 dump，节选）：

```json
{"fileName":"764F…A3A7.png","fileSize":"438107","picWidth":1637,"picHeight":1125,
 "md5HexStr":"764f…a3a7",
 "sourcePath":"<数据根>/nt_qq/<uid>/nt_data/Pic/2026-11/Ori/764f…a3a7.png",
 "originImageUrl":"/download?appid=1407&fileid=…&spec=0",
 "fileUuid":"…","thumbPath":{}}
```

原图**已落盘在 `sourcePath`**（绝对路径）；`originImageUrl` 是无 host 的相对路径，
不能直接当 URL；`thumbPath` 给的是空对象 `{}`（类型标注为字符串，实际形态更松）。

**修复**：路径按 `picPath → picUrl → sourcePath` 取值，空串视为缺失（Windows 侧
`picPath`/`picUrl` 均有值，行为不变）；`canonical.url` 只在 `picUrl` 非空时提供，
不伪造 CDN 域名。发送方向不受影响（`prepareImageElement` 走本地文件 md5 链路）。

## 14. 文件发送通道探测（2026-11-10，通道已探明、上传未落地）

`prepareFileElement` 目前是预留实现（`fileUuid: ""` + `sendMsg` → 恒 `sendStatus=0`）。
本轮用运行时探测把「文件怎么发出去」的候选通道全部摸清，结论与卡点记录如下，供下一轮
直接接续（探针脚本全部临时，不入库）。

### 14.1 结论先行

- **群文件列表无 NAPI 入口**：`getGroupService` 全方法实测 dump（约 200 个）里没有任何
  文件上传/管理方法；`createFileGroupUpload` 只存在于 `NodeIKernelGuildFileTransferService`
  （**频道**，不是群）。所以 OB11 `upload_group_file` 无法做到「进群文件列表」，
  只能实现为**发一条文件消息**（或闪传卡片）。
- **三条候选通道**：① `getBdhUploadService().uploadFile`（底层 BDH）；②
  `getBatchUploadService()`（客户端「发送文件/媒体」的正式管线，**已经真实打到服务端**）；
  ③ `getFlashTransferService()`（闪传，上传文件集 + 发卡片消息）。
- **当前卡点**：②把任务真正跑起来了（回调链、进度、哈希全部正常），但服务端回
  `170019002 Service Failure`（`stepErr=4`，约 50ms 快速失败）；①单独传 `filePath` 只得到
  `status=199` + `url=""`。**业务参数（`sceneType`/`businessType`/`msgInfo`/`fileType.klass`）
  仍未校准**，通道本身没被证伪。

### 14.2 ① BDH：`getBdhUploadService()`

session READY 之前返回 `undefined`（service 未挂载），READY 之后可用。方法面：

```text
addKernelBdhUploadListener, removeKernelBdhUploadListener, setBdhTestEnv,
uploadFile, cancelUpload, processForTask, uploadSmartPttSlice
```

`uploadFile(req)` **只读 8 个属性**（Proxy 实测读取顺序）：

```text
commandId, filePath, bizInfo, priority, uploadTimeout, uuid, extInfo, upKey
```

返回 `uint64` 命令 id（`0` = 直接拒绝）；只给 `{ filePath }` 也能拿到非 0 id
（`fileName`/`fileSize`/`fileMd5` 传了也不读，原生自己算 md5/sha1/sha256）。
回调名是 **`onBdhComplete`**（不是 `onFileUpload*`），签名实测：

```text
onBdhComplete(commandId: string, status: number, <string>, info: {svrResult, url, fileVersion})
```

仅传 `filePath` 时实测 `status=199`、`svrResult=0`、`url=""`（无可用下载地址）。

### 14.3 ② BatchUpload：正式管线（已跑到服务端）

`getBatchUploadService()` 19 个方法（service 层，arity 为 0 参调用时断言实测）：

```text
createBatchUploadConfig(0) -> 返回带默认值的普通对象
getBatchUploadManager(2) / getBatchUploadManagerId(2)
startUploadSession(2) / addTaskToSession(3) / cancelUploadSession(2)
suspendUploadSession(2) / resumeUploadSession(2)
suspendUploadTask(2) / resumeUploadTask(2) / cancelUploadTask(2) / updateTaskInfo(2)
updateTaskReadyStatus(4) / updateSessionBizInfo(3) / updateMaxConcurrentCount(2)
getCachedSessions(1) / deleteCachedSession(2)
removeBatchUploadManagerDelegate(2) / disableUploadThrottling(1)
```

`getBatchUploadManager(config, delegate)` 返回**管理器对象**，其方法面是 service 的子集且
**arity 不同**：`addTaskToSession(2)`、`startUploadSession(1)`、`updateTaskInfo(1)`、
`updateSessionBizInfo(2)`、`cancelUploadSession(1)`、`getCachedSessions(0)`。

**config（`createBatchUploadConfig()` 直接给默认值，可直接改）**：

```json
{"maxConcurrentCount":4,"isStopOnNotWifi":false,"isDisableQuicUpload":false,
 "isDisableBdhUpload":false,"strategy":3,
 "bizConfig":{"appType":0,"agentType":0,"sceneType":0,
   "c2cUserInfo":{"accountType":0,"uid":"","tempSessionKey":{}},
   "groupUserInfo":{"groupCode":"0"}}}
```

**task / session 完整 schema**（原生按此逐字段读取，全字段都要给，缺一个嵌套对象就抛
`Cannot convert undefined or null to object`）：

```text
task:    timeInfo{initUploadTimestamp, beginUploadTimestamp, finishUploadTimestamp,
                  totalUploadTime},
         taskId, seq, isReadyUpload, sessionId, status, isCompleted, bizTransInfo,
         isUploadByBdh,
         errorInfo{stepErr, detailErrCode, srvErrCode, errMsg,
                   bizErrorInfo{errCode, errMsg, errTransInfo}},
         businessType,
         fileInfo{size, md5, sha1, cumulateSha1s, fileName,
                  fileType{klass, pictureFormat, videoCodecFormat, audioCodecFormat},
                  filePath, width, height, time, isOriginal},
         extBizInfo{picExtBizInfo{…9 字段}, videoExtBizInfo{…3 字段}, busiType, bizTransInfo},
         storageExtType, storageExtInfo, rspExtType, rspExtInfo,
         ukey, ukeyTtlSec, ipv4, ipv6,
         msgInfo{msg_info_body, ext_biz_info{…}}
session: timeInfo{…}, sessionId, tasks[], status, successCount, failedCount,
         bizInfo, enableCache
```

**delegate 回调**（注册时不读，事件到达时才取；实测名）：

```text
taskStatusDidUpdate(<native obj>, taskInfo, ?)     status: 1 → 4
taskDidError(<native obj>, taskInfo)
sessionStatusDidUpdate(<native obj>, sessionInfo, ?)
sessionProgressDidUpdate(<native obj>, sessionId, uploaded, total, speed)
sessionDidFinishUpload(<native obj>, sessionInfo)
```

实测轨迹：`status 1`（开始上传，时间戳写入）→ `status 4` + `errorInfo.stepErr=4`、
`srvErrCode=170019002`、`errMsg="Service Failure"`；`sessionProgressDidUpdate` 报
`0 / 52 / 2978909`；原生同时回填 `cumulateSha1s`（说明哈希与分片计算确实跑了）。

**⚠️ 并发会崩**：同一个 manager 上连续启动多个 session（不同 `sessionId`）实测让原生
进程 abort（Bugly 记录 signal + 栈），**一次只跑一个 session**。

### 14.4 ③ FlashTransfer（闪传，语义是分享卡片）

```text
createFlashTransferUploadTask(2)：第 2 参读取
  scene, name, uploaders, permission{code}, coverPath, coverOriginalInfos,
  paths, albumFilePathList, excludePaths, expireLeftTime, validitySeconds,
  uploadSceneType, isNeedDelDeviceInfo, isNeedDelLocation, pathsWithPrivacyInfo,
  detectPrivacyInfoResult{exists, allDetectResults},
  hybridFileInfos, announcement{announcementSegments, modifyTime, avatarUrl}
sendFlashTransferMsg(1)：读取 targets, fileSetId
shouldUseFlashTransfer(1) / getFileMetas(1)
```

即「先把本地 `paths` 传成一个文件集，拿到 `fileSetId`，再用 `sendFlashTransferMsg` 发卡片」。
发出去的是闪传卡片而不是文件消息，与 OB11 `upload_group_file` 语义有偏差。

### 14.5 探针方法（下一轮可直接复用）

- **字段枚举**：wrapper 的 NAPI 绑定用**属性名**读取 JS 对象，传 `Proxy`（`get` 陷阱
  记录 `String(k)`）即可拿到原生读取的字段名与顺序；未知嵌套字段返回「万能递归代理」
  （任意属性再返回代理、可调用）就能让调用穿过去继续走。
- **arity 枚举**：用 0 参调用读断言文本 `assertion (argc == N) failed: ... needs N arguments`，
  argc 不符时原生只断言、无副作用，是零成本签名探测。
- **不要**凭猜测并发跑多个上传 session（见 14.3 的崩溃）。

### 14.6 下一轮的待校准项

> 2026-11-11 更新：第 1、2 项已由 §15 的探测排除（扫参不改变错误码，`sendMsg` 里原生
> 确实会自己发起上传），第 3 项已落地——闪传通道实测可用。结论见 §15。

1. `bizConfig.{appType,agentType,sceneType}` 与 task `businessType`、`fileType.klass`
   的真实取值（`businessType` 扫 0/1/2 都是同一个 `170019002`，说明不是单靠它决定）。
2. `msgInfo.msg_info_body` 是否必须携带「待发送消息」的 PB body（batch upload 可能被设计成
   绑定一条正在编辑的消息）。
3. 若 batch upload 长期过不去，评估闪传兜底，或维持 `upload_group_file` 未实现并在
   OB11 侧返回明确错误（不静默 `sendStatus=0`）。

## 15. 文件发送第二轮：闪传通道打通、文件消息路线证伪（2026-11-11）

第二轮把「有没有别的高层入口」和「到底缺什么参数」两个问题问到了底：全服务盘点证明没有
「进群文件」的上传 NAPI，逐维扫参证明卡点不是业务参数，而**闪传通道实测可以完整投递文件**。

### 15.1 结论先行

- **全服务盘点**（69 个 session service / 104 个导出）确认：没有任何 NAPI 能把文件送进
  **群文件列表**，也没有「给路径就传任意文件」的通用高层入口。
- **文件消息路线也走同一条被拒的传输**：`sendMsg` 带 `fileElement{filePath,…}` 时原生
  **确实会自己发起上传**，返回 `{"result":-1,"errMsg":"rich media transfer failed"}` ——
  不是「缺字段静默失败」，而是这一族传输命令被服务端拒绝。
- **拒绝发生在目标校验之前**：有效群号 / 不存在的群号 / 空群号返回完全一致（`170019002`），
  逐维扫 `cmdType/appType/agentType/klass(0..30)/businessType(0..30)/strategy/urgent/resume`
  全部同一错误 → **卡点不是这些业务参数**（否掉 §14.6 第 1 项）。
- **闪传（FlashTransfer）通道可用**：上传文件集 + `sendFlashTransferMsg` 发卡片，已在测试群
  （1101729931）真实投递成功。语义是**分享链接卡片**（`qfile.qq.com`），不是 `fileElement`
  文件消息、也不进群文件列表。

### 15.2 全服务盘点

`session` 上 `get*` 方法 69 个、导出 104 个。与上传/文件/传输相关的导出：
`NodeIKernel{BatchUpload,BdhUpload,BatchTransfer,FlashTransfer,FileAssistant,FileAutoDownload,FileBridgeClient,FileBridgeHost,GuildFileTransfer,RemoteFile}Service`
与 `NodeIBatchUploadManager`。带 `upload` 的方法共 45 个，真正「能上传任意本地文件」的只有四族：

| 族 | 入口 | 状态 |
|---|---|---|
| ① BDH | `getBdhUploadService().uploadFile` | 只拿到 `status=199` + 空 url（§14.2） |
| ② BatchUpload | `getBatchUploadService()` | 管线跑通、服务端拒 170019002（§14.3） |
| ③ BatchTransfer | `getBatchTransferService().batchTransferUpload` | 命令命中、同样 170019002（§15.3） |
| ④ FlashTransfer | `getFlashTransferService()` | **✅ 上传 + 发卡片全通**（§15.5） |

另有两个**不通用**入口，参数面就对不上需求（实测读取字段）：
`RichMediaService.onlyUploadFile(arg1.guildId)`（只读 `guildId`）、
`RichMediaService.uploadRMFileWithoutMsg({transferId, useNTV2})`（要预先登记的 transferId）。

群文件相关方法**全部**在 `RichMediaService`（60 个方法里 19 个），且只有管理/查询侧：

```text
createGroupFolder downloadGroupFolder renameGroupFolder deleteGroupFolder getGroupSpace
getGroupFileInfo getGroupFileList getGroupTransferList renameGroupFile moveGroupFile transGroupFile
searchGroupFile searchGroupFileByWord searchMoreGroupFile cancelSearcheGroupFile deleteGroupFile
batchGetGroupFileCount queryPicDownloadSize
```

可用性实测：
- `getGroupSpace(groupCode)`：裸字符串即可，返回 `totalSpace`/`usedSpace`（测试群 10 GiB / 已用 1.1 MiB）。
- `batchGetGroupFileCount([groupCode])`：返回 `groupFileCounts`（测试群 1 个文件）。
- `getGroupFileList(groupCode, cb)`：**第 2 参是回调**，传数字会让调用永不返回（见 15.6）。
- `transGroupFile(groupCode, fileInfo)`：实现存在（转存进群文件），但拿不到合法源 `fileInfo`，
  乱填返回 `retCode=-102`「非群成员」。

### 15.3 BatchTransferService（第三个「文件传输」入口）

方法面只有 5 个：`addKernelBatchTransferListener` / `removeKernelBatchTransferListener` /
`generateRandomJobId` / `batchTransferUpload(1)` / `batchTransferDownload(1)`。

`batchTransferUpload(req)` 逐字段读取（35 个，顺序即原生读取顺序）：

```text
taskId,
fileInfo{size, md5, sha1, cumulate_sha1s, file_name,
         file_type{klass, pictureFormat, videoCodecFormat, audioCodecFormat},
         file_path, width, height, time, is_original},
cmdType, businessType, appType, agentType, bizTransInfo,
c2cUserInfo{accountType, uid, tempSessionKey},
groupUserInfo{groupCode},
channelUserInfo{guildId, channelId, channelType},
isUrgentTask, supportResume, uploadEngineStrategy
```

注意 `fileInfo` 里 4 个字段是**蛇形**（`file_name` / `file_path` / `is_original` / `cumulate_sha1s`），
与 batch upload 的驼峰（§14.3）不同——同一层 API 内部命名不统一，照抄必错。

回调与 batch upload 的 delegate **不是一组名字**：

```text
onUploadStart(taskId)
onUploadProgress(…)
onUploadComplete{taskId, errCode, svrErrCode, errMsg, errStep,
                 resultExtInfo{fileUuid, isSecondHit, fileSavePath, downloadSize,
                               totalDownloadTime, finalUrl, domain, urlPath, urlExpiredTime}}
```

诊断矩阵：

| 变体 | 结果 |
|---|---|
| `cmdType=0` | `svrErrCode=170019002`「Service Failure」，`errStep=203` |
| `cmdType=1/2/3` | `svrErrCode=170019001`「illegal params」→ 只有 `0` 是合法命令 |
| 群号=有效 / 不存在 / 空 | **三者完全一致（170019002）** → 服务端在目标校验前就失败 |
| `appType 0..7`、`agentType 0..4`、`klass 0..30`、`businessType 0..30`、`strategy 0..3`、`urgent/resume`、群号数字形态 | 全部同一 170019002 |

用「真实参数 + 未读字段兜底」的记录型代理重放，原生**额外读取字段数 = 0**，说明请求 schema
已经给全 —— 既不是缺字段，也不是字段名错。

### 15.4 文件消息路线（`sendMsg` + `fileElement`）

用记录型代理构造 `{elementType: 3, fileElement:{filePath, fileName, fileSize, file10MMd5,
fileSha, fileSha3, fileUuid:"", expireTime, transferStatus, subElementType:9}}` 调 `sendMsg`：

```text
sendMsg -> {"result":-1,"errMsg":"rich media transfer failed"}
```

即 §14.1 里「`fileUuid: ""` 占位 → 恒 `sendStatus=0`」的真正原因：**原生会拿 `filePath` 自己上传**，
失败点与 15.3 是同一条被拒的传输命令。所以补 `fileUuid` 之类字段不会更好，也不会更差。

### 15.5 闪传通道（唯一跑通）

「上传文件集 → 发卡片」全链路，Linux 原生宿主实测：

1. `createFlashTransferUploadTask(delegate, taskInfo)` —— **调用即开始上传**，不需要再调
   `startFileSetUpload`（该方法的参数语义仍未校准，本轮未用）。`taskInfo` 读取 20 个字段：

   ```text
   scene, name, uploaders, permission{code}, coverPath, coverOriginalInfos, paths,
   albumFilePathList, excludePaths, expireLeftTime, validitySeconds, uploadSceneType,
   isNeedDelDeviceInfo, isNeedDelLocation, pathsWithPrivacyInfo,
   detectPrivacyInfoResult{exists, allDetectResults},
   hybridFileInfos, announcement{announcementSegments, modifyTime, avatarUrl}
   ```

2. 事件（delegate 上按名取，实测顺序）：
   `onFileDidStartUpload` → `onFileUploadStatusChanged` → `onFileSetUploadStatusChanged`
   → `onFileSetUploadProgressChanged` / `onFileUploadProgressChanged` → `onFileDidFinishUpload`；
   另有 `onThumbnailGeneratePath`（`result=1`、"NOT IMPLEMENTED!"，可忽略）。
   `onFileSetUploadStatusChanged` 的 `fileSet.shareInfo.shareLink` 即分享链接，
   `fileSetId` 从这里取（返回值是空对象 `{}`，拿不到 id）。

3. `sendFlashTransferMsg({targets, fileSetId})` —— `targets` 元素**只读两个字段**：

   ```text
   destType   # ChatType：2=群、1=私聊
   destUid    # 群号 / 用户 uid（不是 uin！）
   ```

实测投递（测试群，`getMsgs` 回读确认，`sendStatus=2`）：

```text
els=["1:text:[ 对方通过QQ闪传发送文件给你，请打开链接查看：https://qfile.qq.com/q/PW3KxCL0Ik … ]"]
```

**语义差异（对外文档必须写清）**：闪传发出去的是「分享链接文本消息」，不是 `fileElement`
文件消息，也不进群文件列表。对 `upload_group_file` 而言这是**降级但可用**的投递方式。

### 15.6 探针方法补充（本轮新增）

- **记录型代理优于纯万能代理**：把已知字段填真值、未知字段用递归代理兜底，原生才会走真实分支；
  纯万能代理让所有值都是函数（真值），原生分支会跑偏、读到的字段面偏小。
  判据：换成记录型代理后**额外读取字段数 = 0**，即 schema 完整。
- **先 OFAT 再网格**：7 个维度单独扫（含 `klass 0..30`、`businessType 0..30`）比网格快得多，
  且足以否掉「某个枚举值不对」的假设；命中差异再上网格。
- **命令必须包 timeout**：`getGroupFileList(groupCode, 数字)` 让原生**永久等待**（不抛错、不返回），
  探针进程挂死；探针脚本一律 `timeout <N> node …`。
- **变量名冲突**：复用 `session-smoke.cjs` 头部生成探针时，尾部追加段不能用 `target`/`list` 等
  头部已占用的名字（`const` 重复声明直接语法错）。

### 15.7 落地：`FlashTransferApi`（2026-11-11）

按 15.5 的实测形态封成 kernel API（`packages/kernel/src/apis/flash-transfer.ts`）：

```ts
uploadFileSet(paths, { name?, permissionCode?, timeoutMs? }) // → { fileSetId, shareLink, fileCount }
sendCard(peer, fileSetId)                                     // target → { destType: chatType, destUid: peerUid }
sendFile(peer, paths, opts?)                                  // 上传 + 发卡片一步
```

三处设计取舍：

- **完成判定靠事件计数，不靠返回值**：`createFlashTransferUploadTask` 返回空对象，
  `fileSetId` / 分享链接只能从 `onFileSetUploadStatusChanged` 取；完成条件是「每个文件都有
  `onFileDidFinishUpload`」（按 `cliFileId` 去重，防重复事件提前判定）+ 取到 `fileSetId`。
- **默认 10 分钟超时**（`timeoutMs` 可覆盖）→ 抛 `TIMEOUT`，不静默挂住；监听器在 `finally`
  注销，卸载失败只吞掉（不影响本次结果）。
- **语义边界写在模块头**：这张卡片不是 `fileElement` 文件消息，也不进群文件列表。

对外动作映射**尚未做**：`upload_group_file` 要不要降级到闪传（还是明确报错）是产品决定，
见 PR 说明里的两个选项。
