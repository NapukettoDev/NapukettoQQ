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
