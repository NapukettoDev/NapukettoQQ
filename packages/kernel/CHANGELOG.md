# @napuketto/kernel

## 0.3.0

### Minor Changes

- 8f55c0e: feat(log): 日志可配置化与嵌入式宿主优化——新增 napuketto.toml [log] 段（format: pretty/single-line/json、level 全局+按模块覆盖 cli/kernel/loader/ob11、banner、timestamp: local/iso8601/elapsed、unboundReceive、[log.file] 独立文件 sink 可分级），环境变量覆盖 NAPUKETTO_LOG_LEVEL / NAPUKETTO_LOG_FORMAT / NAPUKETTO_NO_BANNER（兼容旧拼写 NAPKETTO_LOG_LEVEL，全进程链生效）
  
  行为变化（默认生效）：
  - 级别重分配：ob11 校准遥测（onRecvSysMsg/onRecvOnlineFileMsg/onGroupEssenceListChange，含 protobuf hex）与 loader 接收行降 debug；QQ 文件来源/数据目录/自建宿主引导/wrapper 装配/启动账号等引导细节降 debug；账号上线、QR 状态、握手结果、致命错误保持 info 及以上。终端要看接收行配 [log.levels] loader = "debug"
  - warn 级 raw 字段截断为 64 字符 + 缺省长度标注（完整值在 debug 级与日志文件）
  - 时间戳统一单调墙钟（performance.timeOrigin + performance.now()）：修复 QQNT 原生层在 onRecvSysMsg 回调窗口内篡改 Date 导致的假时间戳（实测记录时间冻结为 02:01:55.3 一类常量）
  - 非 TTY（管道/重定向）自动 single-line 且无 ANSI 颜色；TTY 终端输出不变
  - banner 每进程树至多一次（supervisor 派生子进程注入 NO_BANNER）；banner=false 可全关
  - 补过滤 mmkv 变体噪音行（loadFromFile> loading [mmkv）
  
  feat(lifecycle): 优雅关停通道与退出码契约——停止哨兵 <数据根>/napuketto.stop（内容 = 账号 uin 或 all，宿主写文件即触发）与 SIGINT/SIGTERM/SIGBREAK（Windows CTRL_BREAK_EVENT 可达）双通道，内部有序清理（协议适配器停止、事件桥退订）后 exit 0；退出码契约 0 = 请求式正常退出 / 非 0 = 引导失败或致命；napuketto stop 改哨兵优先 + 树杀兜底，taskkill /F 兜底行为保留

## 0.2.5

### Patch Changes

- 3501c01: fix(kernel): 接收方向识别 ARK 卡片（小程序/分享卡片）为 canonical json——此前落 unknown 兜底，OB11 侧整段静默丢弃（纯卡片消息 message 数组为空）、koishi 侧渲染 [unknown] 占位；bytesData JSON 字符串原样透传

## 0.2.4

### Patch Changes

- 677f0ed: fix(kernel/loader): 修复视频消息经 IPC 传输后 thumbPath 丢 Map 形态导致接收链路崩溃与缩略图路径丢失
  
  - kernel：`toCanonicalElements` 读 `videoElement.thumbPath` 改为防御式（`readVideoThumbPath`）——进程内为 `Map<0, path>`，经 JSON/IPC 序列化后退化为平面对象 `{"0": path}`（未规整链路为空对象 `{}`），原实现直接 `.get(0)` 抛 TypeError，整条视频消息事件分派失败（koishi IPC 模式 2026-10-24 线上报错）；类型契约同步放宽为 Map / 平面对象 / 字符串联合
  - loader：IPC 编码（`encodeIpcMessage`，`sendIpc` 统一改走该出口）出站前经 `toJsonSafe` 深规整——`JSON.stringify` 会把 Map 内容全丢（Map → `{}`、Set → `[]`），此前事件 args 里的视频缩略图路径与动作结果（如 `uinToUid` 返回的 `Map`）跨进程后全部丢失；规整后 Map → 平面对象、Set → 数组，配合 kernel 侧防御读取，缩略图路径跨进程完整保留

## 0.2.3

### Patch Changes

- 0e8a808: fix(packaging): `exports["."]` 顶层补 `types` 条件，修复 NodeNext 类型解析
  
  双格式包（`dist` 同时产出 `.mjs` / `.cjs`）此前只在 `import` / `require` 分支内声明
  `types`，只读取顶层 `types` 条件的解析器拿不到声明文件。现于 `exports["."]` 顶层补
  `"types": "./dist/index.d.mts"`，并保留分支内各自的 `types`——顶层这行必须排在
  `import` / `require` 之后，否则 CJS 消费者会被条件匹配劫持到 ESM 声明文件
  （attw: Masquerading as ESM）。
  
  新增 `tooling/package-exports.test.ts` 锁定该形状；attw（node10 / node16 CJS /
  node16 ESM / bundler）与 TS 5.9 / 7.0 消费者矩阵验证通过。

## 0.2.2

### Patch Changes

- cb4bd37: chore(release): 接入 npm OIDC 可信发布与 PR-only 门禁（无功能变更，一次性 patch 用于实证发布链）
  
  - 新增 `.github/workflows/release.yml`：合并带 changeset 的 PR 后，prepare 消费 changeset、构建、测试并推送版本提交；publish 在 `release` environment 审批后逐包 `npm publish`（OIDC 短时 token，无长期凭证，自动 provenance）。
  - 发布前逐包预检 npm 信任配置（`tooling/release/release-trust.ts`），缺配置整批不发，杜绝半批发上 npm。
  - 发布链拆成 `release:version` / `release:build` / `release:test` / `release:publish`，本地 `pnpm release` 复用同口径，仅作演练与应急。
  - CI 增加 `merge_group` 触发，配合主分支 merge queue 与必需状态检查；一切改动走 PR（发布链的版本提交是唯一既定例外）。

## 0.2.0

### Minor Changes

- 3665e63: feat(kernel): 支持视频消息发送（VIDEO 元素）
  
  - canonical `video` 元素扩展 `thumbPath` / `width` / `height` / `durationSec`，收向
    `videoToCanonical` 同步补全（`thumbWidth`/`thumbHeight`/`fileTime`/`Map` thumbPath）。
  - 新增 `MsgApi.prepareVideoElement`：md5 → `getRichMediaFilePathForGuild`
    （`downloadType=1` 原文件 / `2` 缩略图）→ `util.copyFile` 放置 → 完整
    `videoElement`（`thumbPath` 为真实 `Map<0, path>`，JSON 边界会丢成 `{}`）。
  - **修复关键坑**：缩略图目标路径必须用**视频 md5**（`Thumb/<videoMd5>_0.png`），
    `thumbMd5` 只是缩略图内容 md5；用 thumbMd5 算路径会让 native 传输找不到缩略图，
    报 `rich media transfer failed`。
  - `placeMediaFile` 增加 `downloadType` 参数（PIC/PTT 行为不变）。
  - `toSendElements` 的 `video` 分支改为显式报错「需经预处理」，防止绕过。
  - 自建宿主实测（2026-10-17）：`sendMsg` 成功（sendStatus 2/3），群内收到可播放视频；
    详见 `packages/kernel/docs/design.md` §8。
  
  feat(media): 新增 `extractVideoFrame`（ffmpeg 抽首帧 PNG 作视频缩略图）

## 0.1.1

### Patch Changes

- d424c67: fix(kernel): 快速登录超时兜底（T3）——根治软重登永久挂起

  服务端已有同账号会话时底层 quickLoginWithUin/getLoginList NAPI promise 永不
  settle：quickLogin 裸 await 挂起导致 core.login 的 catch/qrFallback 形同虚设、
  QrLoginSession quickUin 路径连 120s 兜底计时都不启动、loader control login 的
  control.release 不执行（登录互斥永不释放、面板无反馈）。

  - quickLogin：getLoginList 与每次 quickLoginWithUin 包 20s 超时竞速
    （CoreLoginOptions.quickLoginTimeoutMs / QuickLoginOptions.quickLoginTimeoutMs
    可配），超时按登录失败（「快速登录失败: 快速登录超时」）抛出，现有
    catch/qrFallback 语义自动生效；超时文案不含网络错误特征，不触发 1006511
    重试叠挂。底层 promise 无法取消，超时后悬挂丢弃。
  - QrLoginSession：quickUin 路径在快速登录前先启动超时定时器（挂起 → 超时
    failed）；失败回退仅限 idle 态，悬挂 promise 迟到结果不复活会话。
  - loader：control login 透传 quickLoginTimeoutMs=20000。

## 0.1.0

### Minor Changes

- 08119ae: feat(kernel/adapter): 无源 notice 事件找源与接线（c3 探测轮）

  - kernel：MsgBridge 新增 onRecvOfflineFileMsg / onRecvOnlineFileMsg / onRecvSysMsg 三通道，GroupBridge 新增 onGroupEssenceListChange（方法名证据 = wrapper.node 9.9.33-52230 字符串扫描：小写回调名偏移同簇 + RTTI + argc 断言；onRecvSysMsg 经 90s 观测窗运行时实触，payload 为原始 protobuf 字节）
  - adapter：新 helper notice-extra.ts——Msg/onRecvOfflineFileMsg 防御性收窄翻译为 OB11 offline_file notice（未知形状 raw 日志）；onRecvSysMsg / onRecvOnlineFileMsg / onGroupEssenceListChange 挂 raw 校准日志（sys msg 为 group_card/group_title/group_sign 的总载体，protobuf 解码为下轮翻译前置）
  - 附带记录：downloadRichMediaInVisit 参数面破案（base 五字段 + elem 元素对象，实测 ok）；msg_emoji_like 无推送回调（仅 API 面）；探测脚本 scripts/probe-scan-strings.mjs 与 scripts/probe-notice-sources.mjs 入库

## 0.0.17

### Patch Changes

- 98385c2: feat(kernel,adapter): 协议能力补全 B1/B2/B4——

  - 语音主动下载（B1）：MsgApi.downloadPtt 接原生 downloadRichMedia（实测签名：单参数对象 {msgId, elemId, chatType, downloadType, thumbSize}，返回 void，轮询消息元素观察完成），get_record 本地未命中时原生下载，失败回退原始路径+元数据；PttElement 补实测字段（transferStatus/progress/fileUuid 等）
  - friend_add 通知（B2）：kernel 新增 BuddyCache（onBuddyListChange 全量快照维护 + 首帧 baseline 不发事件 + diff 归一化 onBuddyAdded/onBuddyRemoved 事件），adapter 翻译为 OB11 friend_add notice（user_id 取 coreInfo.uin）
  - group_upload 报形式开关（B4）：ob11 配置新增 groupUploadAsNotice（默认 false = message 事件 + file 段透出——修复此前 file 元素被静默丢弃的问题；true = 群文件消息改报 group_upload notice 替代 message 事件），配置模板同步

## 0.0.16

### Patch Changes

- 968ed50: feat(kernel/adapter/loader): OB11 request 事件链接线——FriendBridge 好友事件桥（onBuddyReqChange 等回调，方法名来自 wrapper.node 字符串证据）+ OB11 适配器订阅群通知/好友申请推送翻译 request 事件（friend/group_add/group_invite，flag 与应答动作匹配路径一致），loader 装配 Buddy 通道并 IPC 转发

## 0.0.15

### Patch Changes

- 7e35821: fix(kernel): recallMessage 防御脏参数（null/空字符串不再裸抛 TypeError 或透传到 wrapper 层报「无错误详情」，统一抛 INVALID_PARAM；混合脏值只撤回有效 msgId）

## 0.0.14

### Patch Changes

- 19baba2: fix(kernel): 修复 sendMsg 失败导致子进程崩溃（unhandledRejection）

  `MsgApi.sendMessage` 中若 `service.sendMsg` 抛错（wrapper 内部异常），已注册的
  `confirmSend` 确认 Promise 无人消费，随后 `onMsgInfoListUpdate` 确认事件
  （sendStatus=0）触发 `reject` 时变成 unhandledRejection，Node 默认抛错退出，
  直接拖垮整个子进程并连带 IPC 通道关闭。现预消费 confirm 的 rejection 兜底，
  失败语义不变。loader self-host 同步加 unhandledRejection 日志兜底（不退出），
  防止同类漏网 rejection 再拖垮进程。

## 0.0.13

### Patch Changes

- 426cf43: refactor(kernel): msg 富媒体元素裸魔数抽常量并补注释（纯重构，行为零变化）

## 0.0.12

### Patch Changes

- abbde2f: fix(kernel/loader): wrapper 配置硬编码治理——major.node 解析 appid 失败时显式抛 KernelError（删除 537237765 静默兜底，该 appid 属已下线登录服务的 9.9.31），系统信息改为运行时探测（os.release/version/platform，不再写死 Windows 构建号），engine/session 配置裸魔数抽为具名常量并补契约注释。

## 0.0.11

### Patch Changes

- 555e284: fix(kernel/loader): device guid 填空——LoginService 实测为 getMachineGuid（无 getMachineId 方法），kernel 新增 readMachineGuid 原生反射读取，buildSessionConfig 接入 machineGuid，loader 引导时传入设备指纹 guid（反风控）。
- ebc59b5: feat(kernel/loader): IPC control login 指令实现——kernel 新增 qrOnly 登录选项（强制扫码跳过快速登录），loader ipc-server handleControl 接入 login 分支（uin 指定账号 / qr 强制扫码），koishi 插件可经 control login 触发重新登录而不重启子进程。

## 0.0.10

### Patch Changes

- 98c27a3: feat(kernel): QR 登录暴露手动刷新句柄 + 120s 登录超时（复刻 bilibili-dm 扫码交互）

  - `NapukettoCore` 新增 `refreshQr(): boolean`——登录期间持有 `qrSession` 句柄，
    供 koishi 前端「刷新二维码」按钮经 IPC 直达，不再重启子进程
  - `QrLoginSession` 新增 120s 登录超时（照搬参考项目 60×2s）：出码后计时，
    超时未登录 → `failed` + `failureReason`「登录超时，请刷新页面重试」；
    每次 `refresh()` 重置计时，登录成功/失败/stop 清理
  - `LoginProgress` 新增可选 `message`（failed 态失败原因，经 IPC 透出）

## 0.0.9

### Patch Changes

- 9b031ea: 修复：QR 登录快速登录回退逻辑——`quickLoginWithUin` 失败时是 **resolve 带 `loginErrorInfo.errMsg`**（wrapper 契约，非 reject），原实现只挂 `.catch` 导致无登录凭据环境（如 WSL 扫码登录）下回退永不触发：二维码永不产生、完全静默阻塞（无日志无事件）。现改为检查 resolve 结果的 `errMsg` 再回退 `getQRCodePicture()`；同时 `loginByQr` 不再透传 `quickUin`（QR 回退路径下快速登录已失败过一次，二次快速登录在无凭据环境白等一个周期）。

## 0.0.8

### Patch Changes

- c60c34c: 修复：对外 API 新增 CJS 双格式产物（`dist/index.cjs`），`exports.require` 指向 `.cjs`——此前仅发布 ESM（`.mjs`），koishi 适配器（发布形态为 CJS，koishi loader 用 `require()` 加载插件）require kernel/loader 时抛 `ERR_REQUIRE_ESM`，导致适配器无法加载。ESM 消费方（apps/cli 自建宿主）不受影响，仍走 `import` → `.mjs`。

## 0.0.7

### Patch Changes

- 42a9786: fix(kernel): 修复语音发送失败与进程崩溃重启（PTT 元素按 QQ 原生契约预处理）

  此前 `toSendElements` 对 voice 元素只传 `{ filePath }`，wrapper 内部转换 pttElement
  时缺字段抛 "Cannot convert undefined or null to object"，且发送后进程崩溃
  （supervisor 自动重启）。现实现 `preparePttElement`：md5/文件大小计算 →
  `getRichMediaFilePathForGuild` → `util.copyFile` 放置 → 完整 pttElement
  （md5HexStr/fileSize/duration/formatType/voiceType/canConvert2Text/waveAmplitudes
  等，与 PIC 预处理同构）。非 silk 输入（ogg/amr 等）由 wrapper 内部转码，
  实测语音发送成功（sendStatus=2 + 真实 fileUuid）。

## 0.0.6

### Patch Changes

- d6f4b56: refactor(kernel): fallow 健康度重构——43 个 CRAP 超标函数降至 9（行为等价，2026-08-09）

  - **降复杂度**：`wrapper-loader`（startNapuketto/createSession/startSession 回退链拆分）、
    `session-resolver`（findMainSessionId 统一 firstStringId）、`probe` 探测子系统
    （probeStartup/probeSession/enumerateSessionIds 拆小函数）、`login-connect`
    （attemptQuickLogin 提取重试单次）、`lifecycle`（watchInitSignal/startSessionBestEffort）、
    `core`（initLoginConfig/resolveCommonPath/waitQrLoggedIn）、`webapi`（honorTargets
    映射表替代 if 链）、`stranger-info`（pickField 字段级回退）、`group/msg/friend/richmedia`
    （extractGroupDetail/findPttElement/findForwardElement/toDoubtFriendRequestInfo 等纯函数提取）
  - **补测试**（12 个新测试文件，201 → 454 用例全绿）：wrapper-loader / session-resolver /
    probe-utils / event-channel / login-connect / group-cache / wrapper-version /
    wrapper-config / group / friend / msg / richmedia 的 mock 基线测试
  - 全部为行为等价重构（无 API 变化），`pnpm check` / 454 测试 / 全量构建全绿

- f744cf7: fix(kernel): 修复图片发送失败（PIC 元素按 QQ 原生契约预处理：elementType=2 + getRichMediaFilePathForGuild + copyFile + 完整 picElement）
- 769d457: fix(kernel): 修复消息发送失败（sendMsg 返回 result=5 被误判失败）

  问题根因：旧实现以 `sendMsg(msgId, peer, ...)` 调用并直接看返回值 `result===0` 判成败，
  但 wrapper 对正确调用返回 `result=5`（文本/图片均失败）。按 QQ 原生调用契约修复：

  - sendMsg 第一参固定传 `'0'`，msgId 塞 `peer.guildId`
  - 先注册 `onMsgInfoListUpdate` 事件监听再调 sendMsg，以事件 `sendStatus===2` 确认发送成功
    （sendMsg 返回值 result 非 0 不立即判失败——富媒体异步上传时 result=5 常见）
  - `MsgBridge` 补注册 `onMsgInfoListUpdate` 回调（此前缺失，发送状态事件不透传）
  - `MsgApi` 构造支持注入消息事件通道；无通道时退化为旧行为

  实测：文本消息成功发送到群（boot 日志确认）；图片发送错误从模糊的
  `rich media transfer failed` 变为清晰的 `sendStatus=0`（图片仍失败，根因另查）。

## 0.0.5

### Patch Changes

- d6f4b56: refactor(kernel): fallow 健康度重构——43 个 CRAP 超标函数降至 9（行为等价，2026-08-09）

  - **降复杂度**：`wrapper-loader`（startNapuketto/createSession/startSession 回退链拆分）、
    `session-resolver`（findMainSessionId 统一 firstStringId）、`probe` 探测子系统
    （probeStartup/probeSession/enumerateSessionIds 拆小函数）、`login-connect`
    （attemptQuickLogin 提取重试单次）、`lifecycle`（watchInitSignal/startSessionBestEffort）、
    `core`（initLoginConfig/resolveCommonPath/waitQrLoggedIn）、`webapi`（honorTargets
    映射表替代 if 链）、`stranger-info`（pickField 字段级回退）、`group/msg/friend/richmedia`
    （extractGroupDetail/findPttElement/findForwardElement/toDoubtFriendRequestInfo 等纯函数提取）
  - **补测试**（12 个新测试文件，201 → 454 用例全绿）：wrapper-loader / session-resolver /
    probe-utils / event-channel / login-connect / group-cache / wrapper-version /
    wrapper-config / group / friend / msg / richmedia 的 mock 基线测试
  - 全部为行为等价重构（无 API 变化），`pnpm check` / 454 测试 / 全量构建全绿

## 0.0.4

### Patch Changes

- fix: 包 exports 增加 require/default 条件——`@napuketto/*` 被 koishi 插件（CJS 产物）作 dependencies 消费时，`require('@napuketto/kernel')` 此前因 exports 仅声明 `import` 条件而报 `ERR_PACKAGE_PATH_NOT_EXPORTED`。补 `require`/`default` 条件指向同一 `.mjs`（无顶层 await，Node 22.12+ require(esm) 原生同步加载）；插件发布链自动追踪新版本

## 0.0.3

### Patch Changes

- fix(kernel): 群列表数据源校准（2026-08-08，e27fb55）——原生 getGroupList 返回值无数据（仅 `{ result, errMsg }`），列表实际经 onGroupListUpdate 事件推送；GroupCache 新增 listGroups / listGroupsRefreshed；IPC 动作表与 OB11 / Satori 群列表动作改从缓存读，force / no_cache 触发原生刷新

## 0.0.2

### Patch Changes

- 564e383: Barrel 规范化整理（纯结构重构，行为零变化，2026-08-08）：

  - **kernel**：`infra/`、`types/`（含 `listeners/`、`services/` 子 barrel）、`login/`、
    `bridge/`、`apis/` 各建 `index.ts` barrel；`index.ts` 与全 kernel 跨目录引用改走 barrel，
    同目录组内引用保持相对路径（`./result.js` 等）
  - **adapter**：`onebot11/action/index.ts` 升级为真正 barrel（re-export 全部 79 个动作类 +
    error-map + resolve-uid + Ob11ActionDeps + createOb11ActionRegistry）；`onebot11/api/`、
    `satori/api/` 单文件建统一入口；`satori/helper/` 建 barrel（config/error/ids/translate，
    element 子域独立 barrel 不绕行）
  - 包对外 API 签名不变（`packages/*/src/index.ts` 导出面未动）；`.fallowrc.jsonc`
    按 codec/element 先例补充新 barrel 的 ignoreFindings（目录公共面 re-export）

  `pnpm check` / 59 测试 / 全量构建 / fallow（dead files 0%、dead exports 0%）全绿。

- b9f06ca: DDD 目录重组（纯移动 + barrel，行为零变化，2026-08-08）：

  - **kernel**：`wrapper/` 拆出 `wrapper/probe/`（运行时反射探测子系统 5 文件 + barrel）；`index.ts` 改指 probe barrel
  - **adapter**：`satori/helper/` 拆出 `helper/element/`（消息元素域 7 文件 + barrel：解析/渲染/双向转换/资源）；`onebot11/helper/` 拆出 `helper/codec/`（CQ 编解码域 3 文件 + barrel）
  - **loader**：`host/` 拆出 `host/core/`（自建宿主引导编排 7 文件）；tsdown 入口与 `.fallowrc` manual entry 同步改 `host/core/self-host.ts`（产物 `dist/host/self-host.cjs` 路径不变，launcher 默认值无需改）

  全部为 git mv 文件移动 + import 路径调整（组内相对引用保持，跨目录走 barrel），`pnpm check` / 59 测试 / 全量构建 / fallow 全绿，无 API 变化。

- 8e64508: 按 fallow 建议重构 4 个 untested-risk 目标（先建 vitest 测试设施写基线，重构后回归）：

  - **测试设施**：根 `vitest.config.ts` + `pnpm test`（59 用例覆盖 4 个重构模块）
  - **kernel/result.ts**：unwrapResult 错误码映射链 → `RESULT_CODE_RULES` 查找表 + `mapResultCode` 纯函数（cyclomatic 10 → 4）
  - **kernel/probe-serialize.ts**：serialize 分支拆 `serializeContainer`/`serializeArray`/`serializeMap`/`serializeSet`/`serializeObject`（cyclomatic 16 → 6）
  - **adapter/segment.ts**：canonicalToSegment/segmentToCanonical if 链 → 判别式转换器映射表（cyclomatic 12/11 → 1/2）
  - **adapter/element-convert.ts**：elementToCanonical switch → 元素转换器映射表；媒体元素转换器（img/audio/video/file）拆分到 `media-convert.ts`

  全部为行为等价重构（59 测试回归通过，无 API 变化）。

- 9005c43: koishi 适配器 IPC 子进程模式前置（§7 loader 去脚本化，2026-08-08）：

  - **kernel**：`NTEventChannel` 新增 `onAny`（全事件订阅，IPC 整通道转发用）；
    `CoreLoginOptions` 新增 `onLoginProgress` 回调（QR 阶段二维码/状态机转发）；
    `LoginProgress` 类型导出
  - **loader**：新增 `src/host/ipc/`（NAPUTO_IPC=1 开启）——协议类型/编解码/发送封装/
    动作表（msg/group/friend 核心动作，peerUin 自动转 uid）/stdin 服务端（action/control/
    心跳）；`self-host.ts` IPC 分支发 status（booting→dlopening→logging→sessioning→ready/
    failed）；`protocols.ts` 重构拆出 `kernel-services.ts`（服务创建，IPC/协议共用）+
    `assemble-protocols.ts`（OB11/Satori 装配，非 IPC 零回归）；`launcher.ts` 新增
    `LaunchOptions.ipc`（注入 NAPUTO_IPC=1）

  非 IPC 路径（cli pnpm start）行为零变化；`pnpm check` / 198 测试全绿。
