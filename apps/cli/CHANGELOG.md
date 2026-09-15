# @napuketto/cli

## 0.1.20

### Patch Changes

- Updated dependencies [d5c21ca]
  - @napuketto/loader@0.0.33

## 0.1.19

### Patch Changes

- 5bc2aea: fix(adapter): 协议镜像对齐 KuroBridge 改名（kurobridge-ws.v1 / 0.4.0）+ 修复 0.1.18/0.3.0 发布物损坏
  
  - 协议镜像（adapter `schema.ts`）随 KuroAdapter ADR-030 品牌改名对齐：WS 子协议
    `kurobot-ws.v1` → `kurobridge-ws.v1`，PROTOCOL_VERSION 0.3.1 → 0.4.0（帧形状与
    0.3.1 逐字段一致，仅品牌字符串与版本号变更）。**本版起仅与 kurobridge-ws.v1
    服务端（KuroAdapter 改名后版本）互通**；TOML `[accounts.kurobot]` 段名不变。
  - 0.1.18 / 0.3.0 的 npm 发布物 manifest 泄漏 `workspace:*`（`npm install` 直接
    EUNSUPPORTEDPROTOCOL，无法安装），两个版本号作废；本版经 pnpm release 链重新
    发布（release-npm 的 workspace 改写兜底覆盖）。
- Updated dependencies [5bc2aea]
  - @napuketto/adapter@0.3.1

## 0.1.18

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
- Updated dependencies [524e5dc]
  - @napuketto/adapter@0.3.0
  - @napuketto/loader@0.0.32

## 0.1.17

### Patch Changes

- Updated dependencies [fd1daf3]
  - @napuketto/adapter@0.2.1

## 0.1.16

### Patch Changes

- Updated dependencies [e4bdcb3]
- Updated dependencies [d424c67]
  - @napuketto/adapter@0.2.0
  - @napuketto/kernel@0.1.1

## 0.1.15

### Patch Changes

- c36bac0: fix(loader,cli): instance-lock pid 复用根治——pid 探活通过后新增 cmdline 二次校验（新模块 pid-cmdline：Windows 走 PowerShell Get-CimInstance 跨进程查询、Linux 走 /proc，查不到或与锁内摘要不一致视为持有者已死自动接管，根治 2026-09-08「pid 被无关进程复用导致永久拒绝启动」事故）；写锁时自动填本进程命令行摘要（调用方无需显式传）；cli 启动预检走同一判定自动生效，误报提示文案更新
- Updated dependencies [30eeeed]
- Updated dependencies [c36bac0]
- Updated dependencies [08119ae]
  - @napuketto/loader@0.0.31
  - @napuketto/kernel@0.1.0
  - @napuketto/adapter@0.1.0

## 0.1.14

### Patch Changes

- 98385c2: feat(kernel,adapter): 协议能力补全 B1/B2/B4——

  - 语音主动下载（B1）：MsgApi.downloadPtt 接原生 downloadRichMedia（实测签名：单参数对象 {msgId, elemId, chatType, downloadType, thumbSize}，返回 void，轮询消息元素观察完成），get_record 本地未命中时原生下载，失败回退原始路径+元数据；PttElement 补实测字段（transferStatus/progress/fileUuid 等）
  - friend_add 通知（B2）：kernel 新增 BuddyCache（onBuddyListChange 全量快照维护 + 首帧 baseline 不发事件 + diff 归一化 onBuddyAdded/onBuddyRemoved 事件），adapter 翻译为 OB11 friend_add notice（user_id 取 coreInfo.uin）
  - group_upload 报形式开关（B4）：ob11 配置新增 groupUploadAsNotice（默认 false = message 事件 + file 段透出——修复此前 file 元素被静默丢弃的问题；true = 群文件消息改报 group_upload notice 替代 message 事件），配置模板同步

- Updated dependencies [98385c2]
- Updated dependencies [68d34de]
  - @napuketto/kernel@0.0.17
  - @napuketto/adapter@0.0.22
  - @napuketto/loader@0.0.30

## 0.1.13

### Patch Changes

- 9b92ca5: feat(cli): 按账号运维命令——napuketto status/stop/restart [-q <uin>]（PID 状态文件 + 存活检测 + win32 树杀 taskkill /T /F + detached 重启）；supervisor 子进程 stdio 管道化逐行账号前缀转发，账号/ supervisor 运行时状态（pid/启动时间/守护重启计数）结构化落盘 runtime.json / supervisor.json
- Updated dependencies [f13c291]
- Updated dependencies [43a42e1]
- Updated dependencies [59e5492]
- Updated dependencies [36b0144]
- Updated dependencies [968ed50]
- Updated dependencies [94cdb8e]
- Updated dependencies [d480a06]
  - @napuketto/loader@0.0.29
  - @napuketto/adapter@0.0.21
  - @napuketto/kernel@0.0.16

## 0.1.12

### Patch Changes

- Updated dependencies [207d556]
- Updated dependencies [ea754ff]
  - @napuketto/loader@0.0.28

## 0.1.11

### Patch Changes

- Updated dependencies [0c51759]
  - @napuketto/loader@0.0.27

## 0.1.10

### Patch Changes

- Updated dependencies [02c5b13]
  - @napuketto/loader@0.0.26

## 0.1.9

### Patch Changes

- Updated dependencies [d611f72]
  - @napuketto/loader@0.0.25

## 0.1.8

### Patch Changes

- Updated dependencies [be5845c]
  - @napuketto/adapter@0.0.20
  - @napuketto/loader@0.0.24
  - @napuketto/network@0.0.2

## 0.1.7

### Patch Changes

- @napuketto/adapter@0.0.19

## 0.1.6

### Patch Changes

- Updated dependencies [784036b]
  - @napuketto/loader@0.0.23

## 0.1.5

### Patch Changes

- Updated dependencies [7e35821]
  - @napuketto/kernel@0.0.15
  - @napuketto/loader@0.0.22
  - @napuketto/adapter@0.0.18

## 0.1.4

### Patch Changes

- Updated dependencies [47bb6d2]
  - @napuketto/loader@0.0.21

## 0.1.3

### Patch Changes

- Updated dependencies [19baba2]
  - @napuketto/kernel@0.0.14
  - @napuketto/loader@0.0.20
  - @napuketto/adapter@0.0.17

## 0.1.2

### Patch Changes

- Updated dependencies
  - @napuketto/loader@0.0.19

## 0.1.1

### Patch Changes

- Updated dependencies [cd8a030]
- Updated dependencies [426cf43]
  - @napuketto/loader@0.0.18
  - @napuketto/kernel@0.0.13
  - @napuketto/adapter@0.0.16

## 0.1.0

### Minor Changes

- 6903386: feat(cli): 启动接入 QQ 多级来源 + 自动下载管线（resolveQqFiles）——本机未装 QQ 时自动下载官方安装包并缓存，下载失败给出可操作提示

### Patch Changes

- 27a37df: fix(cli): 拒绝占位 QQ 号（123456 / 654321），配置模板护栏硬校验——qq 校验收紧为 5-11 位纯数字并拒绝占位值，占位常量单点定义，两处模板占位注释统一措辞
- Updated dependencies [abbde2f]
  - @napuketto/kernel@0.0.12
  - @napuketto/loader@0.0.17
  - @napuketto/adapter@0.0.15

## 0.0.22

### Patch Changes

- Updated dependencies [555e284]
- Updated dependencies [ebc59b5]
- Updated dependencies [45af90f]
- Updated dependencies [f807879]
  - @napuketto/kernel@0.0.11
  - @napuketto/loader@0.0.16
  - @napuketto/adapter@0.0.14

## 0.0.21

### Patch Changes

- 7872faf: fix(release): 重新发布以修复 npm 包依赖泄漏——此前发布环节绕过 changeset 直发，published 包的 @napuketto/_ 依赖仍是 workspace:_，yarn create / npm install 被迫交互选版本或直接失败；release-npm.ts 现已在发布前把 workspace:\* 改写为 caret 真实版本（发布后恢复），本次随版本号重新发布修正依赖声明
- Updated dependencies [7872faf]
  - @napuketto/adapter@0.0.13

## 0.0.20

### Patch Changes

- @napuketto/adapter@0.0.12

## 0.0.19

### Patch Changes

- Updated dependencies [5bb12a5]
  - @napuketto/loader@0.0.15

## 0.0.18

### Patch Changes

- Updated dependencies [fa86aef]
  - @napuketto/loader@0.0.14

## 0.0.17

### Patch Changes

- Updated dependencies [f42a50c]
  - @napuketto/loader@0.0.13

## 0.0.16

### Patch Changes

- Updated dependencies [98c27a3]
- Updated dependencies [98c27a3]
  - @napuketto/loader@0.0.12
  - @napuketto/kernel@0.0.10
  - @napuketto/adapter@0.0.11

## 0.0.15

### Patch Changes

- Updated dependencies [9b031ea]
  - @napuketto/kernel@0.0.9
  - @napuketto/adapter@0.0.10

## 0.0.14

### Patch Changes

- Updated dependencies [5d4524f]
  - @napuketto/loader@0.0.11

## 0.0.13

### Patch Changes

- Updated dependencies [c60c34c]
  - @napuketto/kernel@0.0.8
  - @napuketto/loader@0.0.10
  - @napuketto/adapter@0.0.9

## 0.0.12

### Patch Changes

- Updated dependencies [affab05]
- Updated dependencies [fa2fb7c]
- Updated dependencies [3507cdd]
- Updated dependencies [52c1519]
- Updated dependencies [de622f5]
  - @napuketto/loader@0.0.9

## 0.0.11

### Patch Changes

- Updated dependencies [42a9786]
  - @napuketto/kernel@0.0.7
  - @napuketto/adapter@0.0.8

## 0.0.10

### Patch Changes

- Updated dependencies [d6f4b56]
- Updated dependencies [f744cf7]
- Updated dependencies [769d457]
  - @napuketto/kernel@0.0.6
  - @napuketto/loader@0.0.8
  - @napuketto/adapter@0.0.7

## 0.0.9

### Patch Changes

- Updated dependencies [d6f4b56]
  - @napuketto/kernel@0.0.5
  - @napuketto/adapter@0.0.6

## 0.0.8

### Patch Changes

- Updated dependencies
  - @napuketto/kernel@0.0.4
  - @napuketto/loader@0.0.7
  - @napuketto/adapter@0.0.5

## 0.0.7

### Patch Changes

- 3265791: feat(cli): 终端渲染登录二维码——loader 在自建宿主（非 IPC）模式经 `NAPUTO_QR` 标记行向 stdout 透出二维码数据，cli `forwardFiltered` 解析后用 qrcode 包渲染终端二维码（png 落盘与 URL 提示保留）；顺带移除未使用的 picocolors 依赖
- Updated dependencies [3265791]
  - @napuketto/loader@0.0.6

## 0.0.6

### Patch Changes

- Updated dependencies [ba49012]
  - @napuketto/loader@0.0.5

## 0.0.5

### Patch Changes

- Updated dependencies
  - @napuketto/kernel@0.0.3
  - @napuketto/adapter@0.0.4
  - @napuketto/loader@0.0.4

## 0.0.4

### Patch Changes

- Updated dependencies [564e383]
- Updated dependencies [b9f06ca]
- Updated dependencies [8e64508]
- Updated dependencies [9005c43]
  - @napuketto/kernel@0.0.2
  - @napuketto/adapter@0.0.3
  - @napuketto/loader@0.0.3

## 0.0.3

### Patch Changes

- 69a53e5: 启动单实例检测（根治多实例抢数据目录锁挂起）：同一账号数据目录（`~/.napuketto/<uin>`）只允许一个实例运行——QQ 原生层（MMKV/登录单例）有锁，第二个实例抢不到会卡在登录初始化后无响应。新增 `instance.lock` 数据目录锁（loader 包）：cli 启动前预检（占用则快速失败并提示占用 PID），self-host 子进程入口兜底获取/释放锁；崩溃残留（PID 已死）自动接管。
- Updated dependencies [007e1ac]
- Updated dependencies [69a53e5]
  - @napuketto/adapter@0.0.2
  - @napuketto/loader@0.0.2

## 0.0.2

### Patch Changes

- d590ab5: 修复 cli bin 在 yarn 1 下启动失败（Windows 用记事本打开 `index.mjs`）：

  - 入口 `src/index.ts` 补 `#!/usr/bin/env node` shebang——yarn 1 依据 bin 文件是否有 `#!` shebang 决定生成 node shim 还是 direct shim；此前无 shebang，yarn 1 生成 `@"...\dist\index.mjs" %*` 的 direct shim，Windows cmd 无法执行 `.mjs`，按文件关联用记事本打开。
  - 修正 `main`/`types`/`exports`/`start` 对不存在的 `index.js`/`index.d.ts` 的死引用，统一指向 `index.mjs`/`index.d.mts`（与 tsdown 实际产物及仓库约定一致）。
