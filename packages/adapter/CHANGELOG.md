# @napuketto/adapter

## 0.3.0

### Minor Changes

- 524e5dc: feat(adapter): 新增 kurobot 协议适配器（KuroBot MVP-3 群服互通）
  
  账号 TOML 配了 `[accounts.kurobot]` 段即启用：作为 kurobot-ws **客户端**主动连入
  KuroBot 服务端（Minecraft 服务器），实现 QQ 群 ↔ MC 双向互通——QQ 群文字进游戏
  广播、游戏聊天/进服/退服/死亡事件渲染进群、群命令前缀转发为游戏命令（结果回群）。
  
  - 连接层自建（子协议 `kurobot-ws.v1`、应用层 ping 15s、断线指数退避 1s→60s、
    close 1002/1008 停止重连）；协议 schema 镜像 KuroAdapter `bridge/protocol`
    0.3.1（golden 帧对表锁漂移）。
  - 配置段：`url` 必填，`token`/`commandPrefix`/`pingIntervalMs`/四个渲染模板可选
    （缺省见 cli 模板注释）；段存在即启用、不写不启用。
  - 装配：loader 按账号段装配（非 IPC 模式）；cli `config-parse`/模板与
    create-napukettoqq 脚手架模板同步。

## 0.2.1

### Patch Changes

- fd1daf3: fix(adapter): parseCqMessage 改为线性 indexOf 扫描，消除不可信消息文本下的多项式回溯（CodeQL polynomial-redos 高危告警）

## 0.2.0

### Minor Changes

- e4bdcb3: feat(adapter): onRecvSysMsg protobuf 解码器落地——手写 wire-format 解码（零依赖，BigInt 保 64 位精度）+ 回调参数防御性收窄 + 信封提取（2 条真实样本校准字段号）+ 识别层。⚠️ 识别表当前为空：card/title/sign 的 (msgType, subType) 判别值无样本支撑，宁可漏报不错报——未识别一律打结构化校准日志不广播；后续拿到真实样本只需往 KIND_TABLE 登记规则即可开始广播对应 OB11 notice。

### Patch Changes

- Updated dependencies [d424c67]
  - @napuketto/kernel@0.1.1

## 0.1.0

### Minor Changes

- 08119ae: feat(kernel/adapter): 无源 notice 事件找源与接线（c3 探测轮）

  - kernel：MsgBridge 新增 onRecvOfflineFileMsg / onRecvOnlineFileMsg / onRecvSysMsg 三通道，GroupBridge 新增 onGroupEssenceListChange（方法名证据 = wrapper.node 9.9.33-52230 字符串扫描：小写回调名偏移同簇 + RTTI + argc 断言；onRecvSysMsg 经 90s 观测窗运行时实触，payload 为原始 protobuf 字节）
  - adapter：新 helper notice-extra.ts——Msg/onRecvOfflineFileMsg 防御性收窄翻译为 OB11 offline_file notice（未知形状 raw 日志）；onRecvSysMsg / onRecvOnlineFileMsg / onGroupEssenceListChange 挂 raw 校准日志（sys msg 为 group_card/group_title/group_sign 的总载体，protobuf 解码为下轮翻译前置）
  - 附带记录：downloadRichMediaInVisit 参数面破案（base 五字段 + elem 元素对象，实测 ok）；msg_emoji_like 无推送回调（仅 API 面）；探测脚本 scripts/probe-scan-strings.mjs 与 scripts/probe-notice-sources.mjs 入库

### Patch Changes

- Updated dependencies [08119ae]
  - @napuketto/kernel@0.1.0

## 0.0.22

### Patch Changes

- 98385c2: feat(kernel,adapter): 协议能力补全 B1/B2/B4——

  - 语音主动下载（B1）：MsgApi.downloadPtt 接原生 downloadRichMedia（实测签名：单参数对象 {msgId, elemId, chatType, downloadType, thumbSize}，返回 void，轮询消息元素观察完成），get_record 本地未命中时原生下载，失败回退原始路径+元数据；PttElement 补实测字段（transferStatus/progress/fileUuid 等）
  - friend_add 通知（B2）：kernel 新增 BuddyCache（onBuddyListChange 全量快照维护 + 首帧 baseline 不发事件 + diff 归一化 onBuddyAdded/onBuddyRemoved 事件），adapter 翻译为 OB11 friend_add notice（user_id 取 coreInfo.uin）
  - group_upload 报形式开关（B4）：ob11 配置新增 groupUploadAsNotice（默认 false = message 事件 + file 段透出——修复此前 file 元素被静默丢弃的问题；true = 群文件消息改报 group_upload notice 替代 message 事件），配置模板同步

- Updated dependencies [98385c2]
  - @napuketto/kernel@0.0.17

## 0.0.21

### Patch Changes

- 43a42e1: feat(media/adapter/loader): get_image/get_record 接主动下载——media 包新增 downloadUrl/inferExtension（fetch + 大小上限 + 超时）；get_image 本地 NT 相对路径按 mediaBaseDir（QQ NT global 目录，装配链经 resolveQqUserDataRoot 解析注入）解析，未命中且有 picUrl 时下载到 cacheDir/media 返回 file；get_record 本地解析命中返回绝对路径（语音主动下载缺口：downloadRichMedia 原生签名未探测，待实测后接入）
- 59e5492: feat(media/adapter): 媒体收发方向接线——media 新增 decodeSilkToWav（silk → 可播放 WAV，收方向语音）并加固 transcodeVideo（exitCode/产物存在性校验，失败抛 MediaError 不再返回幽灵路径）；satori video 非 mp4 输入发送前 ffmpeg 归一化（fail-soft 原样透传）
- 36b0144: feat(adapter): OB11 notice 补全——好友撤回（C2C grayTip REVOKE → friend_recall）、戳一戳（aioOpGrayTipElement → notify.poke，待真实事件验证）；未知 grayTip 子类型与 Buddy 列表变化打 raw JSON 校准日志（friend_add/lucky_notify/honor/essence 翻译的数据源积累入口）
- 968ed50: feat(kernel/adapter/loader): OB11 request 事件链接线——FriendBridge 好友事件桥（onBuddyReqChange 等回调，方法名来自 wrapper.node 字符串证据）+ OB11 适配器订阅群通知/好友申请推送翻译 request 事件（friend/group_add/group_invite，flag 与应答动作匹配路径一致），loader 装配 Buddy 通道并 IPC 转发
- 94cdb8e: feat(adapter): onReload 热更新实现——OB11/Satori 配置变更后 stop 旧传输（心跳/退订/关闭）→ 按新配置重建（P2-6 兑现）；OB11 IPC 桥模式（subscribeOnly）无传输不重建，仅刷新上报开关与消息格式
- d480a06: fix(adapter): WS/HTTP 查询参数鉴权修复——hasAccessTokenQuery 对 req.url（纯路径无 origin）做 new URL 必抛，access_token 参数鉴权从未生效（连接全被 4401 关闭；T10 E2E 实测抓到，改用 dummy base 解析）；OB11 动作 params 缺省空对象（规范允许省略，此前缺 params 一律 1400）
- Updated dependencies [43a42e1]
- Updated dependencies [59e5492]
- Updated dependencies [968ed50]
  - @napuketto/media@0.0.4
  - @napuketto/kernel@0.0.16

## 0.0.20

### Patch Changes

- be5845c: feat: Koishi 插件 IPC 模式整表挂载 OB11 动作容器（79 动作 + ob11 事件透出）——① loader 新增 ipc-ob11 桥：检测 NAPUTO_ADAPTER_ENTRY/NAPUTO_NETWORK_ENTRY 注入时动态 import adapter/network，实例化 NapukettoOneBot11Adapter 仅 subscribeOnly()（接收链路，零网络传输/零配置文件 IO），全部动作名平铺合并进共享 IPC 动作表，OB11 事件经 broadcaster → sendEvent("ob11") 透出，装配失败 fail-soft 降级；② adapter 新增 subscribeOnly()/unsubscribeOnly() 公共方法与公开 registry（IPC 桥枚举挂载用）；③ adapter/network 根导出补 require 条件（koishi 插件 CJS 产物 createRequire.resolve 定位入口用，实际消费仍走 ESM 动态 import）；④ koishi 插件新增 @napuketto/adapter/@napuketto/network 依赖与 ob11Actions 配置（默认开），launcher 透传入口，bot.onOb11 暴露原始 OB11 事件订阅口，bot.internal.\_request("send_like", ...) 直达全部 OB11 动作（返回 OB11 标准信封）
- Updated dependencies [be5845c]
  - @napuketto/network@0.0.2

## 0.0.19

### Patch Changes

- Updated dependencies [3f99e1f]
  - @napuketto/media@0.0.3

## 0.0.18

### Patch Changes

- Updated dependencies [7e35821]
  - @napuketto/kernel@0.0.15

## 0.0.17

### Patch Changes

- Updated dependencies [19baba2]
  - @napuketto/kernel@0.0.14

## 0.0.16

### Patch Changes

- Updated dependencies [426cf43]
  - @napuketto/kernel@0.0.13

## 0.0.15

### Patch Changes

- Updated dependencies [abbde2f]
  - @napuketto/kernel@0.0.12

## 0.0.14

### Patch Changes

- 45af90f: feat(adapter): Satori guild.member.mute 从 501 桩转真实现——接入 kernel GroupApi.setMemberShutUp（Satori duration 毫秒 → QQ 秒），群成员禁言能力接通。
- f807879: fix(adapter): OB11 record 段发送语音时，非 silk 音频自动转码为 silk（QQ 语音格式）再送 kernel；ensureSilk 上移为 adapter core 共享 helper（onebot11/satori 共用），kernel 不 import media 的解耦红线不变。
- Updated dependencies [555e284]
- Updated dependencies [ebc59b5]
  - @napuketto/kernel@0.0.11

## 0.0.13

### Patch Changes

- 7872faf: fix(release): 重新发布以修复 npm 包依赖泄漏——此前发布环节绕过 changeset 直发，published 包的 @napuketto/_ 依赖仍是 workspace:_，yarn create / npm install 被迫交互选版本或直接失败；release-npm.ts 现已在发布前把 workspace:\* 改写为 caret 真实版本（发布后恢复），本次随版本号重新发布修正依赖声明

## 0.0.12

### Patch Changes

- Updated dependencies [2c099aa]
  - @napuketto/media@0.0.2

## 0.0.11

### Patch Changes

- Updated dependencies [98c27a3]
  - @napuketto/kernel@0.0.10

## 0.0.10

### Patch Changes

- Updated dependencies [9b031ea]
  - @napuketto/kernel@0.0.9

## 0.0.9

### Patch Changes

- Updated dependencies [c60c34c]
  - @napuketto/kernel@0.0.8

## 0.0.8

### Patch Changes

- Updated dependencies [42a9786]
  - @napuketto/kernel@0.0.7

## 0.0.7

### Patch Changes

- Updated dependencies [d6f4b56]
- Updated dependencies [f744cf7]
- Updated dependencies [769d457]
  - @napuketto/kernel@0.0.6

## 0.0.6

### Patch Changes

- Updated dependencies [d6f4b56]
  - @napuketto/kernel@0.0.5

## 0.0.5

### Patch Changes

- Updated dependencies
  - @napuketto/kernel@0.0.4

## 0.0.4

### Patch Changes

- fix(kernel): 群列表数据源校准（2026-08-08，e27fb55）——原生 getGroupList 返回值无数据（仅 `{ result, errMsg }`），列表实际经 onGroupListUpdate 事件推送；GroupCache 新增 listGroups / listGroupsRefreshed；IPC 动作表与 OB11 / Satori 群列表动作改从缓存读，force / no_cache 触发原生刷新
- Updated dependencies
  - @napuketto/kernel@0.0.3

## 0.0.3

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

- Updated dependencies [564e383]
- Updated dependencies [b9f06ca]
- Updated dependencies [8e64508]
- Updated dependencies [9005c43]
  - @napuketto/kernel@0.0.2

## 0.0.2

### Patch Changes

- 007e1ac: fallow 静态分析优化（克隆清零）：提取 `createWsServerSchema` 传输工厂（OB11/Satori 共用骨架，消除 config schema 克隆）；清理 4 处纯透传无用构造器（delete/set-essence-msg、satori guild.approve/member.approve）；loader smoke.ts 收敛重复文本提取逻辑为 `extractTexts` helper。
