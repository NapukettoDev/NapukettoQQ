# @napuketto/kernel 实测证据

> 本文件保存 kernel 的探针命令、原生方法面探测结果、原始字段样本与边界行为，仅供深水区
> 排查，不是 API 契约；现行机制见 [design.md](./design.md)。逆向地址类数据不进公共文档。

## 探针与复现命令

两条路径：进程内反射探测（`packages/kernel/src/wrapper/probe/`）与经 loader IPC 的按名调用
（`diag.*`）。探针脚本一律临时、不入库，可复现入口都在下面。

### IPC 调用与探测手法

`packages/loader/src/host/ipc/ipc-actions.ts` 暴露 `diag.sessionCall`、`diag.engineCall`、
`diag.msgServiceCall`、`diag.richMediaCall`、`diag.flashCall`、`diag.utilCall`。
`params.method = "__methods"` 枚举方法面，其余按 `params.args` 调用（JSON 行协议）：

```text
{"v":1,"type":"action","id":"1","payload":{"action":"diag.msgServiceCall","params":
 {"method":"downloadRichMedia","args":[{"msgId":"…","elemId":"…","chatType":2,
 "downloadType":2,"thumbSize":0}]}}}
```

### 方法面、arity 与字段枚举

零成本签名探测：0 参调用读原生断言文本（`assertion (argc == N) failed: … needs N
arguments`），argc 不符时只断言、无副作用；NAPI 方法挂在实例自身而**不在原型**，
`__methods` 需合并 ownKeys 与原型属性名去重。

字段枚举：NAPI 绑定按**属性名**读取 JS 对象，传 Proxy 记录 `get` 陷阱里的 `String(k)` 即得
原生读取的字段名与顺序；未知嵌套字段返回「万能递归代理」（任意属性仍返回代理、可调用）让
调用继续走。判据：已知字段填真值 + 未知字段递归兜底后，**额外读取字段数 = 0** 说明 schema
完整；纯万能代理让所有值都是函数（真值），原生分支跑偏、读到字段面偏小。

### listener 录制器

| 项 | 值 |
|---|---|
| 开关 | `NAPUTO_LISTENER_RECORD=1` |
| 接缝 | loader bootstrap，在 `runProbePhase` 之前（session 就绪、协议装配之后） |
| 产物 | `NAPUTO_CFG_DIR/napuketto-listener-record.jsonl`（本次截断后逐行 append） |
| 行格式 | `{ts, service, event, args}`，args 经 probe-serialize 截断 |
| 合成事件 | `<get>` / `<has>` / `<ownKeys>` / `<registered>`（注册行带 listenerId） |
| 仪器面 | Msg、Group、RecentContact、BdhUpload、OnlineStatus、Lock、FileAssistant、Buddy、ProfileLike、NodeMisc + LoginService |
| 注册方法 | 精确名 `addKernel<简称>Listener` 优先，回退 `/^add(Kernel)?\w*Listener$/` |

原理（`src/wrapper/probe/probe-listener.ts`）：原生 listener 是普通 JS 对象 + NAPI 按名反射
回调，`createRecordingListener` 用 Proxy `get` 返回记录函数（同时记录原生查过的名字），
`has` / `ownKeys` 也记录以判定「按名 Get」还是「枚举发现」；记录函数只序列化入参，绝不
反向调用原生；非字符串键（Symbol）放行默认行为。录制器与业务 bridge 并存（多监听各自独立
id），软重登后随旧 session 失效，重录须重启进程。

首录观察（按名 Get 反射成立，全程无 has/ownKeys 陷阱触发）：11 个服务全部挂上；MsgService
有 5 个 `add*Listener`，正则按字母序会误选 `ImportTool`（真 listener 没挂上、Msg 回调面零
捕获），故改为精确名优先；Buddy 注册即全量首推；群记录伴生 `chatType=7` 影子条目。

### 运行时探测产物

`probeRuntime(ctx)`（`src/wrapper/probe/probe.ts`，`NAPUTO_PROBE=1` 时 loader 调用）输出
`NAPUTO_CFG_DIR/napuketto-probe.json`：session 枚举、各 `get*Service` 方法面、engine 调用、
loginService 形状，`types/services/` 以该产物为权威来源。时序坑：probe 内 `getMainSession`
写回会把空壳主 session 毒化进 `ctx.session`（`session-resolver.ts`），录制器须先于探测取服务。

## 字段样本与边界表现

### downloadRichMedia 族

`NodeIKernelMsgService` 有 `downloadRichMedia` / `getRichMediaElement` / `getLatestDbMsgs` /
`getMsgsByMsgId`（`getMsgs` 需 4 参：peer, msgId, count, false）。`NodeIKernelRichMediaService`
**无**裸 `downloadRichMedia`，只有 `downloadRichMediaInVisit` + downloadFile 族
（`downloadFileForFileUuid` / `downloadFileByUrl` / `downloadFileForFileInfo` /
`downloadFile` / `onlyDownloadFile`）。

```text
NodeIKernelMsgService（单对象参数，二进制断言 needs 1 arguments）
  downloadRichMedia{msgId, elemId, chatType(2=群/1=C2C), downloadType(2), thumbSize(0)} -> Promise<void>
NodeIKernelRichMediaService（单对象参数，比 Msg 版多一个 elem）
  downloadRichMediaInVisit{同上 + elem(必填：完整 element 或媒体子对象)} -> Promise<unknown>
```

- `downloadRichMedia` resolve undefined，结果只能重拉元素观察；参数残缺（msgId/elemId
  undefined）**不抛错**（内部静默 no-op），调用方必须自证参数完整。
- 缺 `elem` 抛 `Cannot convert undefined or null to object`；只加 `elemType` /
  `triggerType` / `peerUid` 不解决，`elem` 是唯一必需差异。
- `pttElement.filePath` 收向是绝对路径
  （`<数据根>/nt_qq/<uid>/nt_data/Ptt/<月>/Ori/<md5>.ogg`），本地命中时 `existsSync` 可用。
- `transferStatus`：4 = 自己发送（已上传）、2 = 收到（数据库标记已下载）。
- transferStatus=2 时调 `downloadRichMedia` **不重新落盘**：把本地文件挪走后调用，12s
  轮询文件不回来、transferStatus 恒 2——wrapper 以数据库状态为准，不查磁盘。有效场景 =
  transferStatus ≠ 2 的未下载消息；已下载但磁盘缺失无法用此方法恢复。
- kernel 策略（`apis/msg.ts` 的 `downloadPtt`）：调用后每 300ms 重拉 `getMsgsByMsgId`，
  34 次（约 10.2s）直到 `filePath` 存在且磁盘命中，超时抛 `TIMEOUT`。

### PttElement 完整字段

收向全字段（`getLatestDbMsgs` 历史消息）：`fileName`/`filePath`/`md5HexStr`/`fileSize`/
`duration`/`formatType`/`voiceType`/`autoConvertText`/`voiceChangeType`/`canConvert2Text`/
`fileId`/`fileUuid`/`text`/`translateStatus`/`transferStatus`/`progress`/`playState`/
`waveAmplitudes`/`invalidState`/`fileSubId`/`fileBizId`/`import_rich_media_context`/`storeID`/
`otherBusinessInfo{aiVoiceInfo, aiVoiceType}`/`isInApplicationDataPath`。后 7 项是补进
`types/entities.ts` 的下载态字段。

### videoElement 字段

| 字段 | 实测值 / 来源 |
|---|---|
| fileName / filePath / fileSize / fileUuid | basename / `getRichMediaFilePathForGuild` 目标路径（Ori） / 字节数**字符串** / 发送空串 |
| videoMd5 / thumbMd5 / fileTime | 视频内容 md5 / 缩略图内容 md5 / 时长（秒） |
| fileFormat / busiType / subBusiType / sourceVideoCodecFormat | 0 / 0 / 0 / 0（均出现过 0 与 1） |
| storeID / original / videoFrom | 1 / true / 0（original 两值均出现） |
| thumbSize / thumbWidth / thumbHeight | 缩略图字节数 / 视频宽高（宽高与视频一致） |
| thumbPath | 进程内 `Map<0, path>`，路径文件名用**视频 md5** |
| 下载态附加字段 | `transferStatus` / `progress` / `invalidState` / `fileBizId` / `originVideoMd5` / `import_rich_media_context` / `isInApplicationDataPath` |

缩略图路径关键实测：真实视频消息 `videoMd5=3d27c01e…`、`thumbMd5=46daaa71…`，实际落盘
`Video/<月>/Thumb/3d27c01e…_0.png`——文件名是视频 md5，不是 thumbMd5。按 thumbMd5 放置会
让 native 按视频 md5 找不到缩略图，整体报 `rich media transfer failed`（20+ 组字段变体全
部失败的真因）。发送侧 `thumbPath` 必须是真实 `Map`（JSON/IPC 序列化会退化成 `{}`；接收
侧三形态由 `types/message-element.ts` 的 `readVideoThumbPath` 统一容忍）。

### PIC 元素跨平台

Linux 原生宿主入站 `picElement` **既无 `picPath` 也无 `picUrl`**（字段缺失，不是空串），
原图已落 `sourcePath`（绝对路径），`originImageUrl` 是无 host 的相对路径，`thumbPath` 是空对象：

```json
{"fileName":"764F…A3A7.png","fileSize":"438107","picWidth":1637,"picHeight":1125,
 "md5HexStr":"764f…a3a7",
 "sourcePath":"<数据根>/nt_qq/<uid>/nt_data/Pic/<月>/Ori/764f…a3a7.png",
 "originImageUrl":"/download?appid=1407&fileid=…&spec=0","fileUuid":"…","thumbPath":{}}
```

取值链 `picPath → picUrl → sourcePath`，空串视为缺失；`canonical.url` 只在 `picUrl` 非空
时给出，不伪造 CDN 域名。Windows 侧 `picPath` / `picUrl` 均有值，行为不变。

### Linux 原生对象空值与 msgTime

- 未命中的元素变体被**显式置 `null`**（`"grayTipElement":null`、`"fileElement":null` …），
  Windows 省略这些字段；元素嗅探的空值判定必须用 `!= null`，用 `!== undefined` 会把普通
  消息误判成 grayTip。
- `msgTime`：Linux 是**秒**字符串（`1794307394`），Windows 是毫秒（`1700000000000`），
  按量级归一到秒；可选对象字段可能是 `{}` 或 `null`，读取侧先做形态判定。

### 枚举与错误码

ARK 卡片：`elementType 10`，`arkElement.bytesData` 是卡片 JSON 字符串，原样透传为
`canonical.json.raw`；为空或缺失落 `unknown` + raw 兜底。其余类型按下表逐个补样本。

| 枚举 | 实测值 |
|---|---|
| 发送状态 sendStatus | 0=失败、1=发送中、2=成功、3=成功无 seq |
| 富媒体 downloadType | 1=原文件（Ori）、2=缩略图（Thumb） |

```text
ElementType: 0 UNKNOWN, 1 TEXT, 2 PIC, 3 FILE, 4 PTT, 5 VIDEO, 6 FACE, 7 REPLY,
8 GRAY_TIP, 9 WALLET, 10 ARK, 11 MFACE, 12 LIVE_GIFT, 13 STRUCT_LONG_MSG,
14 MARKDOWN, 15 GIPHY, 16 MULTI_FORWARD, 17 INLINE_KEYBOARD, 18 INTEXT_GIFT, 19 CALENDAR
```

| 错误码 / 返回 | 含义 | 实测场景 |
|---|---|---|
| 170019002 | Service Failure | BatchUpload、BatchTransfer、fileElement 传输被拒 |
| 170019001 | illegal params | BatchTransfer `cmdType≠0` |
| `stepErr=4` | 传输步骤错误 | BatchUpload 约 50ms 快速失败 |
| `result:-1` + `rich media transfer failed` | 文件传输失败 | `sendMsg` 带 `fileElement` |
| `retCode=-102` | 非群成员 | `transGroupFile` 乱填 `fileInfo` |
| BDH `status=199` | 未完成，url 为空 | 只传 `filePath` 调 `uploadFile` |

### 文件发送通道

四族「能把本地文件传出去」的入口，实测状态：

| 族 | 入口 | 状态 |
|---|---|---|
| BDH | `getBdhUploadService().uploadFile` | 拿到命令 id，但 `status=199` + 空 url |
| BatchUpload | `getBatchUploadService()` | 管线跑通，服务端回 170019002 |
| BatchTransfer | `getBatchTransferService().batchTransferUpload` | 命令命中，同样 170019002 |
| FlashTransfer | `getFlashTransferService()` | 上传 + 发卡片全通 |

全服务盘点（69 个 session service / 104 个导出）确认：没有任何 NAPI 能把文件送进
**群文件列表**，也没有「给路径就传任意文件」的通用高层入口；带 `upload` 的方法 45 个，
四族之外都不通用：`RichMediaService.onlyUploadFile(arg1.guildId)` 只读 `guildId`，
`RichMediaService.uploadRMFileWithoutMsg({transferId, useNTV2})` 要预先登记的 transferId。
群文件方法全在 RichMediaService（60 个里 19 个），只有管理 / 查询侧：

```text
createGroupFolder downloadGroupFolder renameGroupFolder deleteGroupFolder getGroupSpace
getGroupFileInfo getGroupFileList getGroupTransferList renameGroupFile moveGroupFile transGroupFile
searchGroupFile searchGroupFileByWord searchMoreGroupFile cancelSearcheGroupFile deleteGroupFile
batchGetGroupFileCount queryPicDownloadSize
```

- `getGroupSpace(groupCode)` 裸字符串即可，返回 `totalSpace` / `usedSpace`；
  `batchGetGroupFileCount` 返回 `groupFileCounts`；`getGroupFileList(groupCode, cb)` 第 2 参是
  **回调**（传数字永不返回）；`transGroupFile(groupCode, fileInfo)` 乱填回 `retCode=-102`。

**BDH**

session READY 之前 `getBdhUploadService()` 返回 `undefined`，READY 之后可用。方法面：

```text
addKernelBdhUploadListener, removeKernelBdhUploadListener, setBdhTestEnv,
uploadFile, cancelUpload, processForTask, uploadSmartPttSlice
```

`uploadFile(req)` 只读 8 个属性（Proxy 实测读取顺序）：`commandId, filePath, bizInfo,
priority, uploadTimeout, uuid, extInfo, upKey`。返回 `uint64` 命令 id（`0` = 直接拒绝）；
只给 `{filePath}` 也能拿到非 0 id（`fileName` / `fileSize` / `fileMd5` 传了也不读，原生
自己算 md5/sha1/sha256）。回调名是 `onBdhComplete`（不是 `onFileUpload*`），只传
`filePath` 时 `status=199`、`svrResult=0`、`url=""`：

```text
onBdhComplete(commandId: string, status: number, <string>, info: {svrResult, url, fileVersion})
```

**BatchUpload**

19 个 service 方法（括号内为 0 参调用断言实测的 arity）：

```text
createBatchUploadConfig(0) -> 带默认值的普通对象；getBatchUploadManager(2) / getBatchUploadManagerId(2)
startUploadSession(2); addTaskToSession(3); cancelUploadSession(2); suspendUploadSession(2)
resumeUploadSession(2); suspendUploadTask(2); resumeUploadTask(2); cancelUploadTask(2); updateTaskInfo(2)
updateTaskReadyStatus(4); updateSessionBizInfo(3); updateMaxConcurrentCount(2); getCachedSessions(1)
deleteCachedSession(2); removeBatchUploadManagerDelegate(2); disableUploadThrottling(1)
```

`getBatchUploadManager(config, delegate)` 返回**管理器对象**，方法面是 service 子集且 arity
不同：`addTaskToSession(2)`、`startUploadSession(1)`、`updateTaskInfo(1)`、
`updateSessionBizInfo(2)`、`cancelUploadSession(1)`、`getCachedSessions(0)`。
`createBatchUploadConfig()` 直接给默认值（可直接改）：

```json
{"maxConcurrentCount":4,"isStopOnNotWifi":false,"isDisableQuicUpload":false,
 "isDisableBdhUpload":false,"strategy":3,"bizConfig":{"appType":0,"agentType":0,
  "sceneType":0,"c2cUserInfo":{"accountType":0,"uid":"","tempSessionKey":{}},
  "groupUserInfo":{"groupCode":"0"}}}
```

task / session 完整 schema（原生逐字段读取，缺一个嵌套对象就抛
`Cannot convert undefined or null to object`）：

```text
task: timeInfo{initUploadTimestamp, beginUploadTimestamp, finishUploadTimestamp, totalUploadTime},
      taskId, seq, isReadyUpload, sessionId, status, isCompleted, bizTransInfo, isUploadByBdh,
      errorInfo{stepErr, detailErrCode, srvErrCode, errMsg, bizErrorInfo{errCode, errMsg, errTransInfo}},
      businessType, fileInfo{size, md5, sha1, cumulateSha1s, fileName,
        fileType{klass, pictureFormat, videoCodecFormat, audioCodecFormat}, filePath, width,
        height, time, isOriginal},
      extBizInfo{picExtBizInfo{…9}, videoExtBizInfo{…3}, busiType, bizTransInfo},
      storageExtType, storageExtInfo, rspExtType, rspExtInfo, ukey, ukeyTtlSec, ipv4, ipv6,
      msgInfo{msg_info_body, ext_biz_info{…}}
session: timeInfo{…}, sessionId, tasks[], status, successCount, failedCount, bizInfo, enableCache
```

delegate 回调实测名（注册时不读，事件到达才取）：

```text
taskStatusDidUpdate(<native obj>, taskInfo, ?)   status: 1 → 4；taskDidError(<native obj>, taskInfo)
sessionStatusDidUpdate(<native obj>, sessionInfo, ?)
sessionProgressDidUpdate(<native obj>, sessionId, uploaded, total, speed)
sessionDidFinishUpload(<native obj>, sessionInfo)
```

实测轨迹：`status 1`（开始上传、时间戳写入）→ `status 4` + `errorInfo.stepErr=4`、
`srvErrCode=170019002`、`errMsg="Service Failure"`；`sessionProgressDidUpdate` 报
`0 / 52 / 2978909`；原生同时回填 `cumulateSha1s`（哈希与分片计算确实跑了）。

**BatchTransfer**

方法面 5 个：`addKernelBatchTransferListener` / `removeKernelBatchTransferListener` /
`generateRandomJobId` / `batchTransferUpload(1)` / `batchTransferDownload(1)`。
`batchTransferUpload(req)` 逐字段读取（35 个，顺序即原生读取顺序）：

```text
taskId, fileInfo{size, md5, sha1, cumulate_sha1s, file_name,
  file_type{klass, pictureFormat, videoCodecFormat, audioCodecFormat},
  file_path, width, height, time, is_original},
cmdType, businessType, appType, agentType, bizTransInfo,
c2cUserInfo{accountType, uid, tempSessionKey}, groupUserInfo{groupCode},
channelUserInfo{guildId, channelId, channelType}, isUrgentTask, supportResume, uploadEngineStrategy
```

`fileInfo` 里 4 个字段是**蛇形**（`file_name` / `file_path` / `is_original` /
`cumulate_sha1s`），与 batch upload 的驼峰不同——同一层 API 内部命名不统一，照抄必错。
回调不是 batch upload 那组 delegate 名：

```text
onUploadStart(taskId)
onUploadProgress(…)
onUploadComplete{taskId, errCode, svrErrCode, errMsg, errStep,
  resultExtInfo{fileUuid, isSecondHit, fileSavePath, downloadSize, totalDownloadTime,
                finalUrl, domain, urlPath, urlExpiredTime}}
```

诊断矩阵：

| 变体 | 结果 |
|---|---|
| `cmdType=0` | 170019002「Service Failure」，`errStep=203` |
| `cmdType=1/2/3` | 170019001「illegal params」→ 只有 0 是合法命令 |
| 群号有效 / 不存在 / 空 | 三者完全一致（170019002）→ 目标校验前就失败 |
| `appType 0..7`、`agentType 0..4`、`klass 0..30`、`businessType 0..30`、`strategy 0..3` | 全部同一 170019002 |
| `urgent` / `resume`、群号数字形态 | 全部同一 170019002 |

用「真实参数 + 未读字段兜底」的记录型代理重放，原生**额外读取字段数 = 0**：请求 schema
已给全，既不是缺字段，也不是字段名错。拒绝发生在目标校验之前。

**文件消息路线（`sendMsg` + `fileElement`）**

用记录型代理构造 `{elementType: 3, fileElement:{filePath, fileName, fileSize, file10MMd5,
fileSha, fileSha3, fileUuid:"", expireTime, transferStatus, subElementType:9}}` 调 `sendMsg`：

```text
sendMsg -> {"result":-1,"errMsg":"rich media transfer failed"}
```

即 `fileUuid: ""` 占位恒 `sendStatus=0` 的真正原因：原生会拿 `filePath` 自己上传，失败点
与 BatchTransfer 是同一条被拒的传输命令。补 `fileUuid` 之类字段不会更好，也不会更差。

**FlashTransfer（唯一跑通）**

`createFlashTransferUploadTask(delegate, taskInfo)` **调用即开始上传**，不需要再调
`startFileSetUpload`（参数语义未校准）。`taskInfo` 读取 20 个字段：

```text
scene, name, uploaders, permission{code}, coverPath, coverOriginalInfos, paths,
albumFilePathList, excludePaths, expireLeftTime, validitySeconds, uploadSceneType,
isNeedDelDeviceInfo, isNeedDelLocation, pathsWithPrivacyInfo,
detectPrivacyInfoResult{exists, allDetectResults},
hybridFileInfos, announcement{announcementSegments, modifyTime, avatarUrl}
```

事件按名取，实测顺序：`onFileDidStartUpload` → `onFileUploadStatusChanged` →
`onFileSetUploadStatusChanged` → `onFileSetUploadProgressChanged` /
`onFileUploadProgressChanged` → `onFileDidFinishUpload`；另有 `onThumbnailGeneratePath`
（`result=1`、"NOT IMPLEMENTED!"，可忽略）。`onFileSetUploadStatusChanged` 的
`fileSet.shareInfo.shareLink` 即分享链接，`fileSetId` 也从这里取（返回值为空对象 `{}`）。

`sendFlashTransferMsg({targets, fileSetId})`：`targets` 元素**只读两个字段** `destType`
（ChatType：2=群、1=私聊）与 `destUid`（群号 / 用户 uid，**不是 uin**）。实测投递
（测试群，`getMsgs` 回读确认 `sendStatus=2`）：

```text
els=["1:text:[ 对方通过QQ闪传发送文件给你，请打开链接查看：https://qfile.qq.com/q/PW3KxCL0Ik … ]"]
```

语义：发出的是分享链接卡片，不是 `fileElement` 文件消息，也不进群文件列表。kernel 封装
（`apis/flash-transfer.ts`）的取舍：完成判定靠事件计数（每个文件 `onFileDidFinishUpload`
按 `cliFileId` 去重 + 取到 `fileSetId`），不靠返回值；默认 10 分钟超时抛 `TIMEOUT`，
监听器在 `finally` 注销且卸载失败只吞掉。
