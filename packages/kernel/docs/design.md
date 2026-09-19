# @napuketto/kernel 设计书（2026-09-08 首版：覆盖 bridge/event-channel/apis 模块）

> 本包是唯一原生交互层（AGENTS.md 红线 3）：只有 kernel 允许 `process.dlopen`、
> 访问 `wrapper.node`、注册原生 listener。其他包只调语义化 API / 订阅事件通道 /
> 读缓存。无全局单例（ADR-015 推论）：logger/cache/event-channel 均实例化，
> 由 `CoreContext` 持有。本文覆盖 2026-09-08 接线轮次动到的模块；wrapper 加载 /
> login / paths / config 等既有模块详见源码头注释与 `docs/architecture.md`。

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

成功返业务值 / 失败抛 `KernelError`（类型化错误码，协议层映射表消费）。
本次接线相关：

- **friend.ts**：`getBuddyReqList()`（getBuddyReq → buddyReqs）；
  `handleFriendRequest(notify, accept)`（approvalFriendRequest）。
  OB11 `set_friend_add_request` 的 flag = `BuddyReq.reqTime`（拉取匹配）。
- **group-notify.ts**：`getSingleScreenNotifies(doubt, count)` /
  `handleGroupRequest`。OB11 `set_group_add_request` 的 flag = `GroupNotify.seq`。
- **msg.ts**：`fetchMsgsByMsgId(peer, ids)`（get_image/get_record 反查）、
  `placeMediaFile`（发送侧 NapCat 式放置：getRichMediaFilePathForGuild +
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
