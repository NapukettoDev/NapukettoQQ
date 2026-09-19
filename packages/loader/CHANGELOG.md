# @napuketto/loader

## 0.0.34

### Patch Changes

- d3ebd4d: fix(loader): 跨平台路径归一化——反斜杠 Windows 路径在 Linux（WSL/CI ubuntu）下 `basename`/`dirname` 不认 `\` 分隔符导致误判：`isNodeExecutable` 对反斜杠路径恒判非 node、`resolveQqInstall` 切错安装目录（报「QQ 版本目录不存在」）。非 win32 平台先归一化分隔符再取基名/父目录，win32 行为保持不变。

## 0.0.33

### Patch Changes

- d5c21ca: fix(loader): 引导装配补在线状态注册（真机终验发现 I：半在线导致服务端不推送消息）
  
  `createKernelServices` 在 session 就绪后调用 `MsgApi.setOnlineStatus`（status=10，
  与 OB11 set_online_status 动作缺省一致）。此前自建宿主引导链无人调 setStatus——
  真 QQNT 客户端启动即上报在线，缺这一步 = NT 会话半在线：msf 连接可用、消息可发，
  但腾讯侧设备不在线，服务端不推送实时消息（群消息收不到、他端显示「电脑未登录」；
  2026-09-15 KuroAdapter 真机终验出站方向全通、入站零到达，实证定位）。注册失败仅
  告警不阻断 boot。IPC 与协议（cli）模式共用此装配面，软重登重装配时自动重报。

## 0.0.32

### Patch Changes

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

## 0.0.31

### Patch Changes

- 30eeeed: fix(loader): cli（非 IPC）模式 loader logger 同步落盘 logs/loader.log——此前仅 IPC 模式落盘，cli 模式 poke/Buddy 校准等诊断数据全部丢失；console 输出保持不变，IPC 模式关 console 行为（stdout JSON 行协议保护）不变
- c36bac0: fix(loader,cli): instance-lock pid 复用根治——pid 探活通过后新增 cmdline 二次校验（新模块 pid-cmdline：Windows 走 PowerShell Get-CimInstance 跨进程查询、Linux 走 /proc，查不到或与锁内摘要不一致视为持有者已死自动接管，根治 2026-09-08「pid 被无关进程复用导致永久拒绝启动」事故）；写锁时自动填本进程命令行摘要（调用方无需显式传）；cli 启动预检走同一判定自动生效，误报提示文案更新

## 0.0.30

### Patch Changes

- 98385c2: feat(kernel,adapter): 协议能力补全 B1/B2/B4——

  - 语音主动下载（B1）：MsgApi.downloadPtt 接原生 downloadRichMedia（实测签名：单参数对象 {msgId, elemId, chatType, downloadType, thumbSize}，返回 void，轮询消息元素观察完成），get_record 本地未命中时原生下载，失败回退原始路径+元数据；PttElement 补实测字段（transferStatus/progress/fileUuid 等）
  - friend_add 通知（B2）：kernel 新增 BuddyCache（onBuddyListChange 全量快照维护 + 首帧 baseline 不发事件 + diff 归一化 onBuddyAdded/onBuddyRemoved 事件），adapter 翻译为 OB11 friend_add notice（user_id 取 coreInfo.uin）
  - group_upload 报形式开关（B4）：ob11 配置新增 groupUploadAsNotice（默认 false = message 事件 + file 段透出——修复此前 file 元素被静默丢弃的问题；true = 群文件消息改报 group_upload notice 替代 message 事件），配置模板同步

- 68d34de: fix(loader): 登录控制相位机——引导失败后迟到的 control login 成功不再误发 logged_in（防 failed→logged_in 误导序列）；ready 态 control login 原地软重登（清理旧装配面后用新登录结果重跑装配链，免整进程重启）；cli 模式 OB11/Satori 装配失败不再被内部 catch 吞错（回归「判引导失败退出」的既有意图）

## 0.0.29

### Patch Changes

- f13c291: feat(loader): control login 登录期抢占——初始 doLogin 与 control login 竞速（快速登录风控挂起时强制扫码/重登的结果接管装配链）；新增 NAPUTO_QR_ONLY 强制扫码环境变量（launcher qrOnly 选项透传）；修正 ipc-types「预留」过时注释
- 43a42e1: feat(media/adapter/loader): get_image/get_record 接主动下载——media 包新增 downloadUrl/inferExtension（fetch + 大小上限 + 超时）；get_image 本地 NT 相对路径按 mediaBaseDir（QQ NT global 目录，装配链经 resolveQqUserDataRoot 解析注入）解析，未命中且有 picUrl 时下载到 cacheDir/media 返回 file；get_record 本地解析命中返回绝对路径（语音主动下载缺口：downloadRichMedia 原生签名未探测，待实测后接入）
- 968ed50: feat(kernel/adapter/loader): OB11 request 事件链接线——FriendBridge 好友事件桥（onBuddyReqChange 等回调，方法名来自 wrapper.node 字符串证据）+ OB11 适配器订阅群通知/好友申请推送翻译 request 事件（friend/group_add/group_invite，flag 与应答动作匹配路径一致），loader 装配 Buddy 通道并 IPC 转发

## 0.0.28

### Patch Changes

- 207d556: fix: koishi IPC 通道移植原生噪音过滤——wrapper 原生输出整行不再混入协议流

  cli 的 NATIVE_NOISE 过滤移植为 loader 共享助手 `isNativeNoiseLine`（`host/ipc/native-noise.ts` 单一来源，cli 与 koishi IPC 路径同源；IPC 协议行按 `{"v":1` 前缀构造性豁免，防载荷含噪音样文本的消息事件被误滤）。koishi 插件 `ChildProcessIpcTransport` 的 stdout/stderr 行回调接入过滤：整条原生噪音行（MMKV 刷屏 / 符号查找警告等）静默丢弃、不进 onJunkLine 撕裂诊断通道——噪音 ≠ 撕裂，协议行被插断的撕裂仍由 status 重播与脏行诊断兜底。

- ea754ff: 修复 IPC 模式文件日志 ANSI 污染：消息日志 logger 落 plain（IPC 为纯文件 JSON 日志），cli 终端保持彩色；顺带简化 createLoginControlHandler 内仅 IPC 注册路径可达的 ipcMode 死分支

## 0.0.27

### Patch Changes

- 0c51759: 修复自建宿主「登录失败仍上报 ready」：bootstrap() 全链返回 boolean 结果信号，各失败路径（登录失败、协议服务装配失败、kernel 导入/导出异常等）不再被静默吞掉后误报 ready。引导未完成时 IPC 模式补发通用 status failed（已发过带具体错误码的 failed 如 NOT_LOGIN 时不覆盖）并以 exit code 1 退出，交由 koishi driver 既有重启循环接管；cli 模式失败同样退出，不再留驻。附带修复非 IPC 模式 OB11/Satori 装配失败不再 fail-soft 常驻。

## 0.0.26

### Patch Changes

- 02c5b13: fix: IPC 模式「能收不能发」根治——子进程 stdout 承载 JSON 行协议，却被两处 pino console 流（kernel NapukettoCore.create 与 loader kernel-services 的 createLogger）并发写入，协议行撕裂后 koishi 侧解码失败静默丢弃，恰逢 bootstrap 尾部日志密集窗口丢失 status ready，事件照常派发但发送全抛「子进程未就绪（等待驱动连接）」。四层修复：① IPC 模式（NAPUTO_IPC=1）两处 logger 关 console、改文件落盘（kernel logs/napuketto.log 原有，loader 新增 logs/loader.log），cli 输出不变；② 新增 control status 查询指令——子进程快照最近 status 并重播，防原生 printf 直写 fd 等 JS 层拦不住的残留污染；③ driver 自愈：收到 event 但状态未 ready（5s 节流）或 booting 超时（20s 定期）主动查询，ready 分支加幂等守卫防重复 onReady；④ IPC 脏行不再静默丢弃——双侧（koishi client onJunkLine debug 日志 + 子进程 boot 日志）留痕。

## 0.0.25

### Patch Changes

- d611f72: fix(loader): win32 非 node 宿主（Bun 运行时的 koishi 等）自动解析真 node.exe 作自建宿主——此前盲用 process.execPath，Bun 下宿主为 bun.exe，stub QQNT.dll 绑定 node.exe 符号致 wrapper.node dlopen 报 1114「DLL 初始化例程失败」。解析顺序：显式（winNodePath 参数 / NAPUTO_WIN_NODE_PATH）> 系统 PATH node > ensureWinNode 下载（缓存幂等）。

## 0.0.24

### Patch Changes

- be5845c: feat: Koishi 插件 IPC 模式整表挂载 OB11 动作容器（79 动作 + ob11 事件透出）——① loader 新增 ipc-ob11 桥：检测 NAPUTO_ADAPTER_ENTRY/NAPUTO_NETWORK_ENTRY 注入时动态 import adapter/network，实例化 NapukettoOneBot11Adapter 仅 subscribeOnly()（接收链路，零网络传输/零配置文件 IO），全部动作名平铺合并进共享 IPC 动作表，OB11 事件经 broadcaster → sendEvent("ob11") 透出，装配失败 fail-soft 降级；② adapter 新增 subscribeOnly()/unsubscribeOnly() 公共方法与公开 registry（IPC 桥枚举挂载用）；③ adapter/network 根导出补 require 条件（koishi 插件 CJS 产物 createRequire.resolve 定位入口用，实际消费仍走 ESM 动态 import）；④ koishi 插件新增 @napuketto/adapter/@napuketto/network 依赖与 ob11Actions 配置（默认开），launcher 透传入口，bot.onOb11 暴露原始 OB11 事件订阅口，bot.internal.\_request("send_like", ...) 直达全部 OB11 动作（返回 OB11 标准信封）

## 0.0.23

### Patch Changes

- 784036b: fix(loader): WSL 生产事故修复——① Linux spawn 前预检 wine（缺失抛可读错误 + apt 指引），并挂 child 'error' 监听兜底，此前 spawn ENOENT 异步 'error' 无监听者直接 uncaughtException 崩掉整个 koishi；② ensureQqFiles/launchSelfHost 新增 onStage 阶段回调（下载/校验/解包/提取/win-node/spawn 全程日志），首次下载 313MB 安装包不再静默；③ 下载 tmp 文件唯一化（pid+时间戳）并解包前校验存在性，修复「下载成功但 7z 解包报 No such file or directory」并发竞态；④ downloadFile 完成态 stat 校验（缺失/空文件立即报错）

## 0.0.22

### Patch Changes

- 7e35821: fix(kernel): recallMessage 防御脏参数（null/空字符串不再裸抛 TypeError 或透传到 wrapper 层报「无错误详情」，统一抛 INVALID_PARAM；混合脏值只撤回有效 msgId）

## 0.0.21

### Patch Changes

- 47bb6d2: fix(loader): IPC msg.sendMessage 发送前 at 目标归一化——uin（QQ 号）转 uid 并补群成员昵称 display，修复 koishi 插件 at 指定群成员时「@号后面为空」问题（issue #1）

## 0.0.20

### Patch Changes

- 19baba2: fix(kernel): 修复 sendMsg 失败导致子进程崩溃（unhandledRejection）

  `MsgApi.sendMessage` 中若 `service.sendMsg` 抛错（wrapper 内部异常），已注册的
  `confirmSend` 确认 Promise 无人消费，随后 `onMsgInfoListUpdate` 确认事件
  （sendStatus=0）触发 `reject` 时变成 unhandledRejection，Node 默认抛错退出，
  直接拖垮整个子进程并连带 IPC 通道关闭。现预消费 confirm 的 rejection 兜底，
  失败语义不变。loader self-host 同步加 unhandledRejection 日志兜底（不退出），
  防止同类漏网 rejection 再拖垮进程。

## 0.0.19

### Patch Changes

- fix(loader): 修复私聊/临时会话发消息必失败——`attachIpcServices` 把 kernel 的**类方法** `GroupApi.uinToUid` 摘成裸函数注入 IPC 动作表，丢了 `this`，方法内 `this.service.getUidByUins()` 抛 `Cannot read properties of undefined (reading 'service')`（读的是 undefined 的 `service`，即 `this` 为 undefined，与原生服务是否就绪无关）。群聊 peerUid 直通群号不走这条路径，因此只有私聊/临时会话中招。改为 `bind` 注入（与 kernel-services 里 `uidToUin` 的箭头包装写法对齐），并补 `attachIpcServices` 回归单测：用「方法内读 `this.service`」的假 GroupApi，未 bind 时复现同一条报错。同时更正 2026-08-09 对该报错的误判归因（当时归因为「传群号给 getUidByUins」，群聊改直通只是恰好绕开了缺陷路径，私聊一直是坏的）。

## 0.0.18

### Patch Changes

- cd8a030: fix(loader): 清理开发机路径与 UA/版本号硬编码——删除 locate-qq 常见路径探测中的开发机目录候选；下载 User-Agent 改为运行时读自身 package.json 版本（失败兜底 0.0.0）；DEFAULT_WIN_NODE_VERSION 与 SEVEN_ZIP_LINUX_VERSION 补注释说明升级需手动同步。

## 0.0.17

### Patch Changes

- abbde2f: fix(kernel/loader): wrapper 配置硬编码治理——major.node 解析 appid 失败时显式抛 KernelError（删除 537237765 静默兜底，该 appid 属已下线登录服务的 9.9.31），系统信息改为运行时探测（os.release/version/platform，不再写死 Windows 构建号），engine/session 配置裸魔数抽为具名常量并补契约注释。

## 0.0.16

### Patch Changes

- 555e284: fix(kernel/loader): device guid 填空——LoginService 实测为 getMachineGuid（无 getMachineId 方法），kernel 新增 readMachineGuid 原生反射读取，buildSessionConfig 接入 machineGuid，loader 引导时传入设备指纹 guid（反风控）。
- ebc59b5: feat(kernel/loader): IPC control login 指令实现——kernel 新增 qrOnly 登录选项（强制扫码跳过快速登录），loader ipc-server handleControl 接入 login 分支（uin 指定账号 / qr 强制扫码），koishi 插件可经 control login 触发重新登录而不重启子进程。

## 0.0.15

### Patch Changes

- 5bb12a5: feat(loader): IPC 协议契约改为 zod 单一来源——loader 导出 IpcMessageSchema 与全部协议类型（替代 koishi 侧 src/ipc/types.ts 手工镜像，消除两侧类型漂移），新增 zod 依赖；ipc-codec 解码改用 IpcMessageSchema.safeParse（顺带校验 payload 形状，非法 payload 在边界即拦截）。koishi 适配器同步改为消费该契约。

## 0.0.14

### Patch Changes

- fa86aef: fix(loader): Linux 7zz 内置资产优先（治本）+ 版本 2409→2501（止血）

  生产环境 7z 下载 404 根因：7-Zip 官网只保留最新版 tar.xz，硬编码 2409 已被删档
  （实测 404，2501 为当前版）。治本：7zz 静态二进制（2.8MB，LGPL 合规）打进发布包
  `assets/7zip/`（与 Windows 7z.exe 同模式，含 License-linux.txt），`ensureLinuxSevenZip`
  优先级改为 内置资产 > 数据根缓存 > 官网下载兜底（NAPUTO_7Z_URL 可覆盖）——Linux
  引导链不再依赖运行时外网下载 7z。`findSevenZip` 同步支持 Linux 内置资产。
  QQ 安装包保持动态下载（qq-releases.json 清单 + NAPUTO_QQ_URL 覆盖，不变）。

## 0.0.13

### Patch Changes

- f42a50c: 修复 WSL/Linux 生产环境两个问题：① wine 场景 PATH 混入 Unix 路径（冒号分隔）导致 stub QQNT.dll 目录被拆散、wrapper.node 依赖的 QQNT.dll 找不到——PATH 逐条转 Z:\\ 纯 Windows 风格；② Linux 缺少 7z（内置资产是 Windows PE，系统未装 p7zip-full）导致 QQ 安装包解包失败——自动下载 7-Zip 官方 Linux 版 7zz 到数据根 runtime/7zip。

## 0.0.12

### Patch Changes

- 98c27a3: feat(loader): IPC 服务端登录前提前启动 + login.refreshQr 动作

  - 登录前即启动 stdin 服务端（动作表先只含 `login.refreshQr`）——原实现在登录成功
    - 协议装配后才启动，登录中（waiting_scan）前端刷新/control 指令堆积在 pipe
      缓冲区不可达；心跳 ping（15s）同步提前，防扫码耗时超过 45s 被 driver 误判失联强杀
  - 登录后 `attachIpcServices` 把 kernel 服务动作并入同一张共享动作表 + 事件转发
    （`startIpcMode` 拆分为 `createIpcActionsForCore` + `attachIpcServices`）
  - `IpcLoginPayload` / `sendLogin` 新增可选 `message`（失败原因透出）

## 0.0.11

### Patch Changes

- 5d4524f: fix(loader): WSL 下 QQ 安装定位——常见路径探测支持 `/mnt/<盘符>/` 挂载映射，installDir 推导改用 `dirname`（原反斜杠切分在 Linux 路径下切错字符）

## 0.0.10

### Patch Changes

- c60c34c: 修复：对外 API 新增 CJS 双格式产物（`dist/index.cjs`），`exports.require` 指向 `.cjs`——此前仅发布 ESM（`.mjs`），koishi 适配器（发布形态为 CJS，koishi loader 用 `require()` 加载插件）require kernel/loader 时抛 `ERR_REQUIRE_ESM`，导致适配器无法加载。ESM 消费方（apps/cli 自建宿主）不受影响，仍走 `import` → `.mjs`。

## 0.0.9

### Patch Changes

- affab05: feat(loader): QQ 官方安装包自动下载解包缓存（P1，本机无 QQ 场景可用）

  - `qq-releases.json` 版本清单（含 9.9.33-51802 实测 sha256）
  - `qq-download.ts`：https 下载 + sha256 校验（零第三方依赖，NAPUTO_QQ_URL 可覆盖）
  - `qq-extract.ts`：完整版 7z 解 NSIS 安装包 + 提取 resources/app 顶层 `*.node`/`*.dll`（内置 assets/7zip，LGPL 合规；真实 QQNT.dll 由 stub 替代无需提取）
  - `ensureQqFiles()`：下载 → 校验 → 解包 → 提取 → 缓存，幂等（缓存命中直接返回）
  - `resolveQqFiles()` 改 async，L0/L1/L2 全部缺失时自动进入下载流程

- fa2fb7c: feat(loader): QQ 原生文件多级来源定位（P0 跨平台前置）

  新增 `resolveQqFiles()`：L0 `NAPUTO_QQ_FILES` 显式文件根 → L1 本机 QQ 安装（既有逻辑保留）→ L2 数据根缓存 `<数据根>/qq-files/<版本>/` 依次探测，为「本机无 QQ / Linux / Docker」场景铺路；`QqInstallInfo` 新增 `source: "local" | "cached"` 字段。`resolveQqInstall` 旧签名保留兼容。

- 3507cdd: feat(loader): Linux/wine 完整链路登录冒烟脚本（P2 Step 2）

  - `scripts/wine-login-smoke.mjs`：WSL2 一键完整链路冒烟——确保 QQ 文件 → 确保 Windows 版 node.exe → wine 跑 win-node 执行 self-host.cjs（dlopen wrapper.node → O3MiscService 激活 → 登录 → session READY → 协议装配），`--uin` 指定快速登录账号，90s 观察窗口
  - 环境变量装配与 launcher.buildLaunchEnv 同构，路径全部过 toWinePath（Z:\ 视角）

- 52c1519: feat(loader): Linux/wine 平台分支（P2 纯逻辑层）——toWinePath 路径映射 + win-node 下载

  - `wine.ts`：`toWinePath()` Linux 路径 → wine `Z:\` 路径（幂等，含盘符保护）+ `buildSpawnCommand()` 平台分支（win32 本机 node / linux wine）
  - `win-node.ts`：`ensureWinNode()` 下载 Windows 版 node.exe（nodejs.org 官方 zip → 7z 解压 → 缓存，幂等；NAPUTO_WIN_NODE_PATH/NAPUTO_WIN_NODE_VERSION 可覆盖）
  - `launcher.ts`：`launchSelfHost` 变 async，linux 场景自动走 wine + win-node，传给子进程的所有路径过 toWinePath；win32 行为不变
  - cli `boot.ts` 适配 async 调用
  - 新增 `wine.test.ts`（9 单测：toWinePath 5 + buildSpawnCommand 3 + wineBinary 1）

- de622f5: feat(loader): Linux/wine 冒烟脚本 + 实测验证记录（P2 Step 1 固化）

  - `scripts/wine-smoke.mjs`：WSL2 一键冒烟——确保 QQ 文件（P1 自动下载解包）→ 确保 Windows 版 node.exe（P2）→ wine 跑 win-node → dlopen wrapper.node → 断言 98 exports
  - 实测验证通过（2026-08-12 WSL2）：wine 跑 Windows node.exe ✅ / stub QQNT.dll PE 转发在 wine 下生效 ✅ / dlopen wrapper.node 98 exports ✅
  - 设计文档 §3.3 记录实测坑：**wine 读 DrvFS（/mnt/c）会 "File not found"，QQ 文件必须放 ext4**（Docker 无此问题）；dlopen 参数形态 `const m={exports:{}}; process.dlopen(m, ...)`

## 0.0.8

### Patch Changes

- f744cf7: fix(kernel): 修复图片发送失败（PIC 元素 NapCat 式预处理：elementType=2 + getRichMediaFilePathForGuild + copyFile + 完整 picElement）
- 769d457: fix(kernel): 修复消息发送失败（sendMsg 返回 result=5 被误判失败）

  问题根因：旧实现以 `sendMsg(msgId, peer, ...)` 调用并直接看返回值 `result===0` 判成败，
  但 wrapper 对正确调用返回 `result=5`（文本/图片均失败）。按 NapCat 同款方式修复：

  - sendMsg 第一参固定传 `'0'`，msgId 塞 `peer.guildId`
  - 先注册 `onMsgInfoListUpdate` 事件监听再调 sendMsg，以事件 `sendStatus===2` 确认发送成功
    （sendMsg 返回值 result 非 0 不立即判失败——富媒体异步上传时 result=5 常见）
  - `MsgBridge` 补注册 `onMsgInfoListUpdate` 回调（此前缺失，发送状态事件不透传）
  - `MsgApi` 构造支持注入消息事件通道；无通道时退化为旧行为

  实测：文本消息成功发送到群（boot 日志确认）；图片发送错误从模糊的
  `rich media transfer failed` 变为清晰的 `sendStatus=0`（图片仍失败，根因另查）。

## 0.0.7

### Patch Changes

- fix: 包 exports 增加 require/default 条件——`@napuketto/*` 被 koishi 插件（CJS 产物）作 dependencies 消费时，`require('@napuketto/kernel')` 此前因 exports 仅声明 `import` 条件而报 `ERR_PACKAGE_PATH_NOT_EXPORTED`。补 `require`/`default` 条件指向同一 `.mjs`（无顶层 await，Node 22.12+ require(esm) 原生同步加载）；插件发布链自动追踪新版本

## 0.0.6

### Patch Changes

- 3265791: feat(cli): 终端渲染登录二维码——loader 在自建宿主（非 IPC）模式经 `NAPUTO_QR` 标记行向 stdout 透出二维码数据，cli `forwardFiltered` 解析后用 qrcode 包渲染终端二维码（png 落盘与 URL 提示保留）；顺带移除未使用的 picocolors 依赖

## 0.0.5

### Patch Changes

- ba49012: fix(loader): IPC 动作表群聊 peer 解析——peerUin 直通为 peerUid，不再经 uinToUid 转换（getUidByUins 是用户转换 API，传群号属非法调用，QQ 原生内部抛 `Cannot read properties of undefined (reading 'service')`）；错误响应同时落 boot 日志（含完整堆栈）便于诊断

## 0.0.4

### Patch Changes

- fix(kernel): 群列表数据源校准（2026-08-08，e27fb55）——原生 getGroupList 返回值无数据（仅 `{ result, errMsg }`），列表实际经 onGroupListUpdate 事件推送；GroupCache 新增 listGroups / listGroupsRefreshed；IPC 动作表与 OB11 / Satori 群列表动作改从缓存读，force / no_cache 触发原生刷新

## 0.0.3

### Patch Changes

- b9f06ca: DDD 目录重组（纯移动 + barrel，行为零变化，2026-08-08）：

  - **kernel**：`wrapper/` 拆出 `wrapper/probe/`（运行时反射探测子系统 5 文件 + barrel）；`index.ts` 改指 probe barrel
  - **adapter**：`satori/helper/` 拆出 `helper/element/`（消息元素域 7 文件 + barrel：解析/渲染/双向转换/资源）；`onebot11/helper/` 拆出 `helper/codec/`（CQ 编解码域 3 文件 + barrel）
  - **loader**：`host/` 拆出 `host/core/`（自建宿主引导编排 7 文件）；tsdown 入口与 `.fallowrc` manual entry 同步改 `host/core/self-host.ts`（产物 `dist/host/self-host.cjs` 路径不变，launcher 默认值无需改）

  全部为 git mv 文件移动 + import 路径调整（组内相对引用保持，跨目录走 barrel），`pnpm check` / 59 测试 / 全量构建 / fallow 全绿，无 API 变化。

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

## 0.0.2

### Patch Changes

- 007e1ac: fallow 静态分析优化（克隆清零）：提取 `createWsServerSchema` 传输工厂（OB11/Satori 共用骨架，消除 config schema 克隆）；清理 4 处纯透传无用构造器（delete/set-essence-msg、satori guild.approve/member.approve）；loader smoke.ts 收敛重复文本提取逻辑为 `extractTexts` helper。
- 69a53e5: 启动单实例检测（根治多实例抢数据目录锁挂起）：同一账号数据目录（`~/.napuketto/<uin>`）只允许一个实例运行——QQ 原生层（MMKV/登录单例）有锁，第二个实例抢不到会卡在登录初始化后无响应。新增 `instance.lock` 数据目录锁（loader 包）：cli 启动前预检（占用则快速失败并提示占用 PID），self-host 子进程入口兜底获取/释放锁；崩溃残留（PID 已死）自动接管。
