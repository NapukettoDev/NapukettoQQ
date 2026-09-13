# NapukettoQQ 项目现状（2026-09-08 更新：🔌 接线收尾轮——request 事件链 / control login / 媒体双向 / onReload / 运维命令；🌙 登录与装配链生命周期收尾轮——A1 竞态修复 + A2 ready 态软重登）

> **新对话开场指引**：先读本文件（现状 + 关键决策点）→ `AGENTS.md`（工程指南 + 红线）→ `docs/architecture.md`（架构书）→ **`packages/loader/native/docs/HANDOVER-V11.md`（最终交接，闭源子仓库）** → 对应包 `docs/design.md`（loader / koishi-plugin-adapter / create-napukettoqq / **kernel（2026-09-08 新建）** / **adapter（2026-09-08 新建）**）。需要细节时再读 HANDOVER-V6~V10（子仓库 docs/）。需要了解路线演进背景时再读 `docs/DECISIONS.md`。涉及**登录 / 停启实例 / instance-lock / stderr 噪音排查**等实操时先读 `docs/OPERATIONS.md`（运维与实验规程，2026-09-10 固化）。
>
> **git 状态**：2026-09-08 晚已完成**全链补签 + 历史线性化**（rebase 重写：20 个提交全部 GPG 签名、纯线性无合并；并行会话推来的重复历史链已随改写移除，内容零损失）。HEAD = `4cdc19f`（pnpm-lock 同步）；**旧哈希全部作废**（3fa6425 / a1f8a2a / 9562829 / 7faed0f 等），引用旧哈希的文档与脚本以提交信息为准。登录生命周期收尾轮详见「🌙 关键决策点」。

---

## 📋 遗留清单现状（2026-09-10 核对快照，HEAD 08119ae）

> **时点快照**：一轮并行修复正在推进（软重登挂起 / checkIdentity 单测 /
> sysmsg 解码器），**并行修复轮落地合并后本节需刷新**。核对基准 =
> 08119ae（c3 无源事件探测轮）；行号为该时点实测。

| 遗留项 | 现状 | 出处（时点行号） |
|---|---|---|
| **软重登挂起**（quickLoginWithUin 永不 settle → qrFallback 接不住 → control release 不执行 → claim 互斥不释放） | **未修（修复进行中）**；现存唯一缓解 = login-race 相位抢占口，ready 态软重登无任何兜底 | `kernel/src/login/login-connect.ts:284`（裸 await）+ `kernel/src/core.ts:187`（qrFallback 靠 catch）+ `loader/src/host/core/relogin.ts:220-221`（finally release）+ `kernel/src/login/login.ts:162`（QR 兜底定时器只在 refresh 里启动，挂起则连超时都不计时） |
| **checkIdentity 专属单测** | **进行中**（三分支齐全但现有测试零覆盖，直接单测需先调可见性） | `apps/koishi-plugin-adapter/src/bot/bot.ts:369` |
| **onRecvSysMsg protobuf 解码器**（group_card / group_title / group_sign 翻译回填） | **进行中**（订阅后仅 raw 校准日志，仓内无解码器） | `packages/adapter/src/onebot11/adapter.ts:264` |
| **msg_emoji_like** | **已结案**：wrapper 无推送回调（仅 API 面 getMsgEmojiLikesList 7 参），无源可接 | 2026-09-10 🔍 决策点第 2 条 |
| **offline_file / group_essence** | **已接线，待自然事件校准**（防御性收窄翻译，payload 待真实事件回填） | c3 轮 08119ae |
| **probe-scan-strings.mjs** | **已入库** | `scripts/probe-scan-strings.mjs` |
| **旧锁保守占用 / cmdLine 残余差异** | **按设计自愈、已声明接受**（旧锁无 cmdline → 保守判占用，随新锁普及自愈；8.3 短路径 / 相对启动路径等残余差异源已在注释声明接受，误判方向 = 可恢复的误接管） | `loader/src/instance-lock.ts:96` + `loader/src/pid-cmdline.ts:17-21` 注释 |
| **bot 级「造残留锁 → 启动自动接管」实机复核** | **待独占窗口**（单测完备 15 例、实机未跑；checklist 已固化 → `docs/OPERATIONS.md` §4，禁止并行会话执行） | `docs/OPERATIONS.md` §4 |

> 同账号双实例互斥规程（先停常开树再登录、恢复终态核对）也已固化 →
> `docs/OPERATIONS.md` §1。

---

## 🔍 关键决策点（2026-09-10：c3 无源事件探测轮——五 notice 事件找源 + InVisit 参数破案）

> 探测产物：`scripts/probe-scan-strings.mjs`（wrapper.node 字符串扫描，判定标尺 =
> 小写回调名偏移同簇性 + RTTI + argc 断言）与 `scripts/probe-notice-sources.mjs`
>（IPC 宿主动态验证）。证据矩阵详见 kernel design.md §1「c3 新接线」。

1. **offline_file 源已接线**：`Msg/onRecvOfflineFileMsg`（RTTI 硬证据）→
   adapter notice-extra.ts 防御性收窄翻译（payload 待真实事件校准）。
2. **group_card / group_title / group_sign 载体已接线 = `Msg/onRecvSysMsg`**
   （sys msg 总闸；**运行时实触**，90s 观测窗 2 次）——payload 是**原始
   protobuf 字节**，解码器是下轮翻译前置。msg_emoji_like **无推送回调**
   （仅 API 面 getMsgEmojiLikesList 7 参），无源可接。
3. **清单外**：onGroupEssenceListChange 已接线（group_essence 候选源）；
   poke API（sendNudge）/ typing（onInputStatusPush）/ honor 观测候选记录在案。
4. **T4 破案**：downloadRichMediaInVisit 参数 = base 五字段 **+ elem 元素对象**
   （实测加 elem 后 ok；MsgService 版已够用，不替换）。
5. 附带发现：onRecvMsgReadReport/onRecvMsgReceipt 在 9.9.33-52230 无字符串
   痕迹（疑版本差异死接线，无害）。

---

## 🌙 关键决策点（2026-09-08：登录与装配链生命周期收尾轮，A1+A2）

> loader design.md §10 为本轮完整设计书。核心：

1. **A1 登录竞态修复**：control login 成功结果改为按**引导相位**分派
   （`relogin.ts` LoginControl：login-race → assembling → ready / aborted）——
   引导失败（aborted）或装配进行中（assembling）迟到的成功结果**不再上报**
   logged_in（原无条件上报会制造 failed→logged_in 误导序列：koishi 收到
   logged_in 但子进程无协议装配，上线后所有请求失败）。
2. **A2 ready 态原地软重登**：ready 相位 control login 成功 → 清理旧装配面
   （OB11 桥退订+动作表移除 → IPC 事件转发退订+动作表移除 → 三桥/缓存/
   消息日志 dispose）→ 用新登录结果重跑装配链 → 重播 ready + logged_in。
   koishi 决策表 logged_in 态改走 control login（不再整进程重启）；failed
   与登录期行为不变。防重入：control login 全程互斥，在途指令忽略（拍板：
   不排队——软重登窗口秒级而登录可在途很久，排队会面板失真）。
3. **软重登换账号防线**：driver ready 幂等守卫下 onReady 不重触发，
   checkIdentity 由 logged_in 登录消息面补位（driver-events onLoggedIn）——
   换账号登录拒绝上线（同 2026-08-20 事故防线）。跨账号 session 有效性
   未实测（activateSession 幂等守卫下同账号复用 session），静态推演 +
   单测覆盖（bootstrap-relogin.test.ts 断言清理顺序/重装配调用/状态推送）。
4. **顺手修复**：cli 模式 assembleOb11AndSatori 内部 catch 吞错（protocols.ts
   「装配失败判引导失败退出」意图被短路，装配失败曾以假 ready 留驻）——
   现正常抛出；同函数返回 ob11/satori stop（存 services.stopAdapters）。
   kernel-services 新增 dispose()；setupMsgLogging 返回退订函数。
5. **并行会话注意**：本轮工作区同时存在另一会话的 kernel/adapter WIP
   （语音主动下载 B1，downloadPtt/downloadRichMedia）——本轮提交严格按
   文件路径外科式隔离，未触碰。

---

## 🔌 关键决策点（2026-09-08：接线收尾轮，T1-T10，历史存档）

> 背景：2026-09-07 全仓审计发现三端断链（kernel 事件零订阅 / adapter 类型零生产 /
> loader 指令零消费）+ 媒体函数零调用 + 验证欠账。本轮全部接线：

1. **OB11 request 事件链接通**：kernel 新增 FriendBridge（Buddy 通道，
   `onBuddyReqChange` 等，方法名来自 wrapper.node 9.9.33-52230 字符串证据）；
   adapter 订阅 `Group/onGroupNotifiesUpdated` + `Buddy/onBuddyReqChange` 翻译
   request 事件（friend / group_add / group_invite；flag 与应答动作匹配路径一致：
   seq / reqTime）。Buddy 回调 payload 形状未实测——防御性收窄 + raw 校准日志。
2. **koishi control login 接通**：登录期（idle/waiting_scan/scanned）重登走
   `control login {uin}` 原地接管（loader 端 **登录期抢占**：control login 成功
   结果与初始 doLogin 竞速——快速登录风控挂起时强制扫码也能走完装配链）；
   ready/failed 走 control restart；「扫码登录」新增（登录期 control login
   qr=true；其余状态一次性 NAPUTO_QR_ONLY 标记 + 重启直接出码）。
   ~~ready 态**原地软重登**未做（需装配链重跑，遗留）~~
   → **同日晚些的「登录生命周期收尾轮」已实现**（见上方 🌙 第 2 条）。
3. **媒体双向接线**：koishi 发送侧 http(s) img/audio 先下载临时文件再发
   （30MB/15s 限制，失败回退占位文本）；koishi 收向语音 silk→WAV 可播放
   （fail-soft）；satori video 非 mp4 ffmpeg 归一化（fail-soft）；
   get_image 接主动下载（本地 NT 路径解析 + picUrl 下载到 cacheDir/media）。
4. **onReload 热更新兑现**（P2-6）：OB11/Satori 配置变更 stop 旧传输 → 新配置
   重建；OB11 IPC 桥模式无传输仅刷新上报开关。
5. **cli 运维命令**：`napuketto status/stop/restart [-q <uin>]`（选型：PID 状态
   文件 runtime.json/supervisor.json + win32 taskkill /T /F 树杀 + detached
   重启；supervisor 子进程 stdio 管道化账号前缀转发）。
6. **notice 补全**：friend_recall（C2C 撤回）、notify.poke（aioOp，**待真实事件
   验证**，poke 路径恒打 raw 日志）；未知 grayTip 子类型 raw 校准日志。
   gap：group_upload 仍以 message+file 段报（改 notice 待拍板）、group_card/
   offline_file/group_sign/msg_emoji_like/group_title 无源、friend_add 待校准。

---

## 🏆 历史关键决策点（2026-08-07/08，存档，标题沿用）

> **配置结构拍板（2026-08-08）**：用户指出旧结构缺陷——顶层 `[onebot11]`/`[satori]` 段全局共享
> （多账号端口冲突、无法按账号启停协议）、QQ 号不是必填项。重构定案：
> 1. **一个 QQ 账号一个 `[[accounts]]` 段，协议与通信配置嵌在账号内**（`[accounts.onebot11]` /
>    `[accounts.satori]`，TOML 数组表子表语法，smol-toml 支持）；账号没写某协议段 = 不启用该协议。
> 2. **账号必填**：`[[accounts]]` 至少一个（qq 必填），删掉「配置为空 → 交互式单账号登录」老路径；
>    无账号启动直接报错提示编辑模板。
> 3. **数据根默认移到 `<项目根>/.napuketto`**（部署原因不放用户目录；`resolveDataRoot` 支持 `~`/
>    相对路径展开）；根 `napuketto.toml` 为本机配置不入库（.gitignore）。
> 4. 装配链：loader `loadProtocolSections(kernel, uin)` 登录成功后按 uin 从 accounts 取协议段
>    zod 校验作 seed（ConfigBase seed 模式），未配置协议的账号不装配对应协议。

---

## 🎉 session READY 突破（2026-08-07 深夜，历史存档）

> **🎉 决定性突破（2026-08-07 深夜，HANDOVER-V9，推翻 V8「硬墙」结论）**：自建宿主（标准 node +
> stub QQNT.dll）**session 业务 service 可激活**——关键 = **`session.init(config)` 之后调
> `startupSession.start()`**（NapCat initializeSession 顺序）。改正顺序后
> `onOpentelemetryInit(is_init=true)` 触发，**getMsgService READY（298 方法）+ getGroupService/
> getBuddyService/getTicketService/getProfileService 全部有效**。此前失败（V8 记录）是因为
> 先 `ssw.start()` 再 init（顺序颠倒）或 init 后 startNT（非 startupSession.start）。
> 隔离实验：O3 上报 / UUID guid / deviceConfig 均非必要。**路线 A 可救，产品路线主攻。**
>
> **✅ 自建宿主验证通过（2026-08-07，p0-login3.mjs）**：纯 Node（系统 node v24）+ 9.9.33 官方
> wrapper.node + stub QQNT.dll 转发 + `O3MiscService` 激活事件分发 → **完整登录成功**
> （getLoginList 7 账号 → onLoginConnected → quickLoginWithUin 成功）。
>
> **✅ stub QQNT.dll 等价物完成（2026-08-07 晚，HANDOVER-V7/V8）**：
> llvm-mingw 编译 **69KB PE 转发 stub**（100 条：99 静态转发 + PerfTrace 空实现），替换 NapCat
> 闭源 stub（481KB）后完整登录成功——**产品化前置解除**（正式版 stub-qqnt.cpp 已在 native 子仓库）。
>
> 三要素（勿重复探索）：① 加载 = **stub QQNT.dll 转发**（napi_* → node.exe，无需 IAT 改写；
> host-helper IAT 方案事件分发不工作已弃用）② **`NodeIO3MiscService.get()` + `addO3MiscListener`**
> 激活事件分发（否则 getLoginList 永不 resolve）③ commonPath/desktopGlobalPath = `数据根/nt_qq/global`。
>
> **session READY 四步（V9 决定性）**：登录成功 → `session.init(config, depends, dispatcher, listener)`
> → **`startupSession.start()`**（先 init 后 start！）→ 等 `onOpentelemetryInit(is_init=true)`。
>
> 下一步：kernel 落地（修正 lifecycle initAndStartSession 顺序）→ 冒烟收发 → 内存实测 → loader
> 自建宿主引导（NAPUTO_SELF_HOST 分支）。账号注意：快速登录 <测试QQ号> 会挂起（账号风控），
> 测试用 **<测试QQ号>**（已验证成功）。

**功能范围（用户拍板）**：**NapCat 全部能力（协议 + API）− WebUI − 插件系统**。
**逆向边界（用户拍板：非 0 逆向）**：允许必要逆向——环境模拟/反风控（进程名伪装、
模块隐藏、RWX→RX、窗口类）、数据包层 hook（Frida Gum 等价物）、无头阻断。
业务层优先 NAPI（优先级非禁令），技术手段不设限但仅限 loader 载具层；**许可证底线不变：
零引入 NapCat 代码**。详见 `AGENTS.md` 第 7 条。

**背景**：路线 A（自建宿主 + env 兼容层）曾用**已下线的 9.9.31** 判死（P0-B：纯 Node 下
QQNT.dll 事件分发对象无人初始化 → 登录崩溃）。但后来发现 **NapCat 纯 Node 模式（9.9.27 +
napi2native）能跑通**（无 QQ 进程无 UI，双进程仅 ~237MB，且能登录）——判死可能不成立。

**napi2native 真实职责（字符串分析实证，不是 env 兼容层）**：
- 反风控/环境模拟：进程名伪装 QQ.exe、隐藏注入模块（K32EnumProcessModules/GetModuleHandleW hook）、
  内存 RWX→RX 伪装、创建 `Base_PowerMessageWindow`（QQ 窗口类，QQNT.dll 内部依赖窗口消息循环）、
  数据包层 hook（Frida Gum，可选）

**自建宿主失败的可能真相**：
1. P0-B 用的是 9.9.31 的 QQNT.dll（**登录服务已被腾讯下线**，后来升级 9.9.33 扫码才成功）——崩溃可能是版本问题而非纯 Node 问题
2. napi2native 创建的窗口类可能对登录有用（QQNT.dll 依赖窗口消息循环）
3. ~~**未验证**：9.9.33 QQNT.dll + 纯 Node + 窗口类 + 票据能否登录~~ **已验证通过（2026-08-07）**：
   纯 Node + stub QQNT.dll 转发 + O3MiscService 激活事件分发 + 快速登录成功

**验证实验（可决定性区分，已完成）**：
```
9.9.33 资源 + 纯 Node dlopen(wrapper.node) + 建 Base_PowerMessageWindow + 已有票据登录
成功 → 自建宿主可救（百兆级可达，产品路线 = 自建宿主优先）
失败 → 才是 env 硬墙，路线 B（300MB 注入）为产品路线
```
> **✅✅ 已验证可救（2026-08-07 深夜，HANDOVER-V9）**：登录 ✅ + **session READY ✅**（先 init 后
> startupSession.start()，业务 service 全部激活）。不是 env 硬墙。

**产品路线（2026-08-07 深夜最终；2026-08-07 用户拍板：路线 B 淘汰，自建宿主唯一路线）**：
| 路线 | 形态 | 内存 | 状态 |
|---|---|---|---|
| **A. 自建宿主（唯一路线）** | 标准 Node + stub QQNT.dll 转发（napi_* → node.exe）+ O3MiscService 激活 | ~100MB（待实测） | ✅✅ **唯一实现**（登录 + session READY + 冒烟收发 + onebot11 装配） |
| **B. 注入 utilityProcess Worker**（NapCat 同款） | 注入 QQ 主进程 → worker dlopen | 300MB+ | ❌ **已淘汰（2026-08-07 用户拍板）**，仅历史回退 |
| C. V1/V2 注入（主进程直接引导） | — | 1.01GB | ❌ 已排除 |

---

## ✅ 已验证结论（全部实测，勿重复探索）

### 路线 B 全链路（❌ 已淘汰，2026-08-07 用户拍板；以下为历史存档）

```
pnpm start（apps/cli）
  └─ NapukettoBootMain.exe 拉起 QQ.exe + 注入 NapukettoWinBootHook.dll（自研 V1 资产）
  └─ hookdll IAT hook → 引导 boot.cjs（NAPUTO_ROUTE_B=1 分支）
  └─ boot.cjs fork utilityProcess Worker（继承 QQ env）→ route-b-worker.cjs
       └─ worker 内 process.dlopen(wrapper.node) → exports 98 个（QQ env 原生，无需 IAT 改写）
       └─ boot-bootstrap.js 复用 → kernel 装配 → 登录（快速/QR）→ session → 协议装配
  └─ 无头：阻断 UI/GPU/Renderer（vehicle.cpp 已有）；主进程保留但无窗口
```

**P2-0 试金石通过（c42d20d）**：① appid 从 major.node 动态解析（9.9.33-51802 = **537376818**，
NapCat parseAppidFromMajorV2 自研等价）② session 用 NapCat 方式
（`StartupSessionWrapper.create()` → `getNTWrapperSession("nt_1")` → `startupSession.start()`，
**不要 `new NodeIQQNTWrapperSession()`**——cpp_impl 断言失败）③ **getMsgService READY（1s）+
msgService 299 方法**（addKernelMsgListener/sendMsg/fetchMsgList 全在）。

**P2-1 代码落地（ad8a926）**：① 快速登录网络重试（lifecycle.ts：waitForNetworkConnection
轮询 getMsfStatus()===3 + quickLogin 1006511 重试×3）② 冒烟自检（boot-smoke.js，NAPUTO_SMOKE=1
触发：MsgBridge+MsgApi 真发/收一条 + 落库核对）③ cli 启动方式已改自建宿主（`launchSelfHost`，路线 B 注入链路淘汰）。

**P0-A（env 兼容层）**：IAT 改写 wrapper.node 99/101 槽 → node.exe 标准实现 → 89 exports。
**结论**：知识资产（证明 wrapper.node 可脱离 QQ Electron 完整加载），路线 B 用不上、自建宿主复活可参考。

### 产品化状态（已提交，勿重复实现）

| 迁移项 | 位置 | 说明 |
|---|---|---|
| appid 动态解析 | `packages/kernel/src/wrapper/wrapper-config.ts` | `parseAppidFromMajor` + `resolveAppidQua` + `externalVersion: false` |
| NapCat 式 session 创建 | `packages/kernel/src/wrapper/wrapper-loader.ts` | createSession：SSW.create → getNTWrapperSession("nt_1") → create 回退；startSession 优先 startupSession.start() |
| 自建宿主入口 | `packages/loader/src/host/core/self-host.ts`（产物 `dist/host/self-host.cjs`） | dlopen + O3MiscService 激活 + bootstrap(state) 复用 |
| 自建宿主启动 | `packages/loader/src/launcher.ts` | `launchSelfHost`（唯一启动方式，替代已淘汰的路线 B 注入链路） |
| 快速登录重试 | `packages/kernel/src/login/lifecycle.ts` | waitForNetworkConnection + 1006511 重试×3 |
| 冒烟自检 | `packages/loader/src/host/core/smoke.ts` | NAPUTO_SMOKE=1 触发收发验证 |

---

## 📦 已完成功能（截至 2026-08-06，均有提交）

- **kernel**：errors/paths/logger/config（TOML）/event-channel/wrapper 全套（version/loader/config/adapters）/
  context+core 装配层 / lifecycle / login（QR 状态机 + 快速登录重试）/ MsgBridge + GroupBridge /
  cache（GroupCache 只读视图）/ **apis 12 个**（Msg/Group/GroupNotify/Friend/Ticket/RichMedia/Profile/
  ProfileLike/WebApi + PathWrapper 等）——详见 `packages/kernel/README.md`（design.md 待补写）
- **adapter**：core 框架（BaseProtocolAdapter/BaseAction/ActionRegistry/AdapterRegistry/ProtocolConfig）
  + onebot11 全量（**79 个动作（含别名变体）**，message/group/friend/system 四分组 + api 聚合 OneBotApi + GroupCache
  消费 + error-map + CQ 码 + 事件模型 + HTTP/WS 传输 + 鉴权 + 心跳）
- **koishi 插件 OB11 动作桥（2026-08-27）**：IPC 模式（`NAPUTO_IPC=1`）下 loader 检测
  `NAPUTO_ADAPTER_ENTRY`/`NAPUTO_NETWORK_ENTRY` 注入时整表挂载 OB11 动作容器（79 动作
  平铺合并进 IPC 动作表 + `subscribeOnly()` 接收链路 + ob11 事件透出；零网络传输、
  零配置文件 IO、fail-soft）——koishi 侧 `bot.internal._request("send_like", ...)` 直达
  全部 OB11 动作；详见 loader design.md §9 与插件 design.md §5.14
- **network**：完整（HttpServer/HttpClient/WsServer/WsClient/EventBroadcaster）
- **media**：完整（image/audio(silk)/video(ffmpeg)）
- **loader**：自建宿主引导（launcher `launchSelfHost` / locate-qq / host/core 引导编排）+ 闭源 stub QQNT.dll
  （native/，仅分发编译产物）；V1 注入框架（bootmain/hookdll）与 V2 载具（vehicle.cpp）已归档 archive/
- **cli**：commander（-q/-d/--qq-path）+ 一键启动（读全局配置 accounts）+ config 子命令
  （init/list/apply，napuketto.toml 单一 TOML）+ supervisor 多账号编排
- **配置路径修订（2026-08-07）**：全局配置文件移到项目根 `<项目根>/napuketto.toml`（用户拍板：
  不喜欢配置堆用户目录），数据（账号目录/日志/缓存/QQ 数据）仍按数据根组织；kernel 新增
  `resolveConfigPath`（NAPKETTO_CONFIG 显式 > 项目根探测 > cwd > 数据根兜底），
  cli config 子命令 / boot / loader 装配链同步更新
- **网络配置多实例化 + 配置模板（2026-08-07，P2-18）**：ob11ConfigSchema 对齐 NapCat——
  httpServers / httpPostUrls / wsServers / wsReverseUrls 四个**数组实例**（每实例 enabled/
  host/port/url + 实例级 token 覆盖全局），新增 `reportSelfMessage`（自身消息上报开关，
  缺省 false）与 `messagePostFormat`（array=消息段数组 / string=CQ 码）；WsClientOptions 增
  `rejectUnauthorized`（wss 自签证书，对齐 NapCat enableSelfSigned）；cli 内置 CONFIG_TEMPLATE
  （TOML 注释版，与 `create-napukettoqq` 脚手架模板 `templates/*.tmpl` 同款；项目根 `napuketto.toml.example` 已删除——2026-08-07 用户质疑与 cli 模板/脚手架模板三处重复），`config init` 与首次启动缺失时
  生成带注释模板（已存在则跳过不覆盖）；**HTTP SSE 服务器明确不做**（OneBot 11 规范无此模式，
  2026-08-07 用户拍板）。冒烟验证通过（模板解析 + 多实例装配 + HTTP 实发 200）。

**API 来源分层**（回答「onebot11 规范吗」）：标准 OneBot 11 规范 30 个 + go-cqhttp 扩展 + NapCat
扩展三层；`protocol_version: "v11"` 不变，扩展动作 schema 来自 NapCat/go-cqhttp 而非规范，以
`packages/adapter/src/onebot11/action/index.ts` 注册表为准（design.md 待补写）。对齐度 ≈ 70%。

---

## 🎯 功能范围（2026-08-06 用户拍板：NapCat 全部能力 − WebUI − 插件系统）

| NapCat 能力域 | 我们 | 差距 |
|---|---|---|
| OneBot 11 协议（HTTP/WS/反向） | ✅ 79 动作（含别名变体） | 对齐 ≈70%，缺冷门扩展 |
| Satori 协议 | ✅ 已实现（2026-08-08，commit 0612fc7） | HTTP RPC + WS 事件服务 + 元素 XML 编解码 + 20 动作 + 4 类事件 |
| 扫码/快速登录 | ✅ | 无 |
| 纯 Node 自建宿主 | ✅ 已验证（唯一路线） | 登录 + session READY + 收发 + onebot11 装配全通 |
| 数据包层（packet 后端） | ❌ | 逆向已解禁，远期对齐 |
| WebUI / 插件系统 | ❌（红线） | **明确不做** |

## 🔥 下一步（按优先级，2026-09-08 接线收尾轮后）

### 0️⃣ 自建宿主落地（✅ 已完成，唯一路线）
- [x] 登录链路 / stub QQNT.dll / session READY / launchSelfHost（2026-08-07 全通，见历史存档）
- [x] **内存实测（2026-09-08 T10 完成）**：见下方「端到端实测」实测数据
- [ ] 校准数据回收：poke / Buddy 回调 payload / grayTip 未知子类型 raw 日志
  （loader.log 积累中）——真实事件到达后回填翻译（adapter design.md §6）

### 端到端实测（2026-09-08 T10）
- [x] 实机跑 `pnpm start`（自建宿主），`NAPUTO_SMOKE=1` 冒烟收发验证通过（群消息真实接收，历史）
- [x] **OneBot 外部链路端到端（2026-09-08 T10 ✅ 通过）**：OB11 WS（127.0.0.1:3001，
  token 鉴权）+ 临时客户端脚本（scripts/e2e-ob11-client.mjs）——事件上报（meta
  heartbeat）+ 动作调用往返（get_login_info retcode=0）全通；**抓到并修复两个
  真实 bug**：① WS 查询参数鉴权从未生效（new URL 相对路径必抛，连接全 4401）
  ② 动作缺 params 一律 1400（规范允许省略，现缺省 {}）
- [x] **内存实测（2026-09-08 T10）**：登录态 + session READY + OB11 WS 装配稳态：
  self-host 进程 ~186MB（wrapper+kernel+adapter）+ boot 转发进程 ~54MB，
  合计 ~240MB——与 NapCat 纯 Node ~237MB 同量级（差 ~3MB）
- [x] **读类返回形状校准（2026-09-08 T10 ✅）**：经 OB11 动作面实测
  get_group_member_info（kernel getMemberInfo 的 infos Map 提取路径正确）、
  get_group_member_list、get_group_system_msg（getSingleScreenNotifies 路径，
  当前无待处理请求返回三空数组）全部 retcode=0；校准脚本
  scripts/e2e-shape-calibration.mjs（写类严禁调用）
- [x] **Buddy 列表事件 payload 首次真实捕获**：onBuddyListChange = BuddyCategory[]
  全量快照（含 buddyList 明细 uid/uin/coreInfo/baseInfo/status/vasInfo）；
  onBuddyListChangedV2 = boolean。→ friend_add 翻译策略应为快照 diff（下一轮）
- [x] **多账号实测**：跳过——本机配置仅 1 个有效账号段（第二段为注释模板），
  按约束不自行添加账号
- [x] **poke 实测**：本轮会话无真实 poke 事件到达，翻译口径仍待校准（raw 日志持续积累）
- [ ] 多账号实测（本机 2 个有效账号段；未在本轮执行则遗留下一轮）

### 协议能力对齐（B 轮，2026-09-08 晚完成三项）
- [x] 语音主动下载（B1）：downloadRichMedia 实测签名（msgService 单参数对象，
  返回 void，轮询元素观察完成；transferStatus=2 已下载态为 no-op——详见
  kernel design.md §5）+ MsgApi.downloadPtt + get_record 本地未命中原生下载
- [x] friend_add 翻译（B2）：kernel BuddyCache（onBuddyListChange 快照维护 +
  首帧 baseline 不发 + diff 归一化事件）→ adapter toFriendAdd
- [x] group_upload 报形式开关（B4）：groupUploadAsNotice（默认 false =
  message + file 段透出——修复此前 file 元素被静默丢弃；true = 改报 notice），
  配置模板已同步；真下载行为（transferStatus≠2 样本）本机无法自然构造，待补
- [x] ready 态原地软重登（koishi 面板不重启进程重登；2026-09-08 登录生命周期
  收尾轮 A2 完成——loader 相位机 + 重装配 + koishi 决策表/checkIdentity 补位，
  见 🌙 决策点与 loader design.md §10；跨账号真实切换实测待补）
- [ ] 数据包层（packet 后端，远期）；版本兼容（appid 表维护）

### P3 打磨
- [x] supervisor 复用 + 按账号运维命令（status/stop/restart，2026-09-08 T8）
- [ ] 版本兼容：wrapper-version.ts 探测 + appid 表维护（QQ 升级重跑 major 解析）

---

## ⚠️ 关键环境事实（务必记住）

- **QQ 已升级 9.9.33-52230（2026-09-08 实测本机）**：`C:\Program Files\Tencent\QQNT\`
  （wrapper.node 114MB；本机注册表探测已命中）。9.9.33-51802 曾在 `<项目/工作目录>\QQNT\`。
  旧 9.9.31 登录服务已被腾讯下线，扫码「请下载最新版」
- **appid 机制**：每版本从 major.node 的 `QQAppId/` 标记提取。9.9.33-51802 = 537376818；9.9.31 = 537237765
- **session 必须 NapCat 方式**：`getNTWrapperSession("nt_1")` 或 `StartupSessionWrapper.create()`，
  不要 `new NodeIQQNTWrapperSession()`（cpp_impl 断言失败）
- **initConfig 必须 `externalVersion: false`**（扫码兼容）
- **commonPath** 用 `getNTUserDataInfoConfig()` 返回路径的 `nt_qq/global`，engine desktopGlobalPath 同
- **QQ 登录数据**：`<用户目录>\Documents\Tencent Files\`（含 7 个账号）
- **NapCat 参考**：`<NapCat Shell 部署包目录>`（Shell 部署包，纯 Node 模式实证 ~237MB）

---

## 🚫 红线（两路线都适用，来自 AGENTS.md 第 7 条）

1. **零引入 NapCat 代码**（GPL-2.0 / Limited Redistribution License 与 MIT 不兼容；napi2native 闭源）；
   只借鉴架构动作，实现自研
2. **允许必要逆向（2026-08-06 用户拍板）**：环境模拟/反风控（进程名伪装、模块隐藏、RWX→RX、
   窗口类）、数据包层 hook、无头阻断均可逆向；业务层**优先** NAPI（优先级非禁令），
   NAPI 覆盖不了的能力用 C++ 逆向补足；技术手段不设限但**仅限 loader 载具层**
3. **零磁盘篡改**：内存 Patch 只在运行期 RAM；严禁改 QQ 安装目录二进制
4. **逆向产物不进公共仓库**：RVA 表 / Offset 仅存私有（`native/` 只分发编译+混淆二进制）

---

## 🌱 环境坑（复用历史）

- PowerShell PATH 间歇失效 → 用绝对路径（python/g++/taskkill）
- 崩溃子进程占 DLL 句柄 → 编译 Permission denied → 杀残留 node 进程
- wrapper.node 加载后进程不退出（后台线程）→ 测试脚本需 process.exit
- bootmain 拉起 QQ 后挂起 → async 模式 + 观察日志文件
- read_file 对正在写入的 boot.log 有缓存 → 用 PowerShell `Get-Content -Raw`

---

## 🎮 kurobot 协议适配器（KuroBot MVP-3，2026-09-14 追加）

> 任务书 `docs/KUROBOT-PROMPT.md`；决策与实测实录 `docs/KUROBOT-NOTES.md`。
> napukettoqq 原生新增**第三协议** kurobot：账号 TOML 配 `[accounts.kurobot]`
> 段即启用，作为 kurobot-ws **WS 客户端**主动连入 KuroBot 服务端（MC 服务器），
> QQ 群 ↔ MC 双向互通（文字互转 / join/leave/death 通知进群 / 群命令前缀 →
> 游戏命令 + 结果回显）。与 KuroAdapter 侧 MVP-3（external 端口基座）并行开发，
> 契约锚点 = 其 master `b0809ef`（协议 0.3.1）。

- **位置**：`packages/adapter/src/kurobot/`（schema 镜像 / connection 自建连接层 /
  translate 映射 / adapter 主体 / config schema），复刻 satori 模式（core 框架
  BaseProtocolAdapter + ProtocolConfig seed）；`./kurobot` 子路径导出（ADR-014）。
- **连接层自建**（不改 network）：子协议 `kurobot-ws.v1` + 应用层 ping 15s
  （服务端只认应用层入帧）+ 指数退避 1s→60s + close 1002/1008 停止重连 +
  未知帧容忍（对齐 ADR-026）；每次重连重发 hello。
- **测试**：adapter 单测 +46（假 kurobot-ws 服务端真端口全链路 + golden 帧对表
  锁 0.3.1 漂移 + 映射/渲染/命令链）+ 冒烟 scripts/kurobot-smoke.test.ts +3
  （真 loader 取段 + dist 构建产物 + 假服务端双向帧）；全仓 899 用例绿。
- **装配**：loader assemble-protocols kurobot 分支（段非空才装配，url 必填）、
  cli config-parse/模板、create-napukettoqq 模板同步；changeset 已写
  （adapter minor + loader/cli/create-napukettoqq patch，未发版）。
- **遗留**：@kurobot/protocol 发版切真依赖、富文本上行、status 命令式查询
  （query 能力已就绪未接 QQ 触发面）、wss 客户端配置——见 NOTES 债务清单；
  真实群服互通终验（QQ 扫码在场）待 KuroAdapter 侧 MVP-3 完成后按其
  peer-guide 联调（任务书 §7）。
