# 运行链路

> 面向贡献者与 AI 代理：从 CLI 命令到 QQ 原生调用、再到协议输出的完整链路。字段与默认值
> 见 [configuration.md](../guides/configuration.md)；协议翻译见各协议文档。

## 进程拓扑

```
CLI（node dist/index.mjs）
├─ 单账号：当前进程即 boot 进程
│    └─ 自建宿主子进程（node dist/host/self-host.cjs）
└─ 多账号：supervisor 进程
     └─ 每个账号一个 boot 子进程 → 各自一个自建宿主子进程
```

自建宿主进程内：

```
stub QQNT.dll（PATH 前置）/ libnapuketto_stub.so（LD_PRELOAD）
  └─ process.dlopen(wrapper.node)
       └─ kernel（engine / loginService / session）
            ├─ 事件通道 + 事件桥 + 缓存 + 业务 API
            ├─ adapter（onebot11 / satori / milky）→ network 传输（HTTP / WS / SSE）
            └─ adapter（kurobot）→ 自带 WS 客户端
```

- **没有 QQ 进程、没有注入、没有 UI**：标准 Node 通过 stub 转发 `napi_*` / `uv_*` /
  `qq_magic_*` 等宿主符号。Windows 优先用当前 Node；Bun 等非 Node 宿主由 loader 另找或
  下载 `node.exe`。Linux 用系统 `node` + ELF 全局符号表（ADR-027）。账号之间进程隔离：
  一个账号一个宿主进程，天然满足 kernel“无全局单例”。

## 启动序列

### CLI 准备

单账号入口 `runSingleAccount`：

1. 解析数据根（`--data-dir` > `NAPKETTO_DATA` > `<项目根>/.napuketto`），得到账号目录
   `<数据根>/<uin>`（未指定 `-q` 时为 `<数据根>/default`）。
2. 定位 QQ 原生文件（见下文），得到 `wrapperPath` 与版本；预检实例锁，已被存活实例占用则
   快速失败并提示 PID。
3. 解析 kernel / adapter / network 的 dist 入口，调 `launchSelfHost`；子进程 `cwd` 指向
   数据根（QQ 原生层就绪前可能向 cwd 落盘），`NAPKETTO_CONFIG` 指向全局配置。

多账号 `runSupervisor` 读 `accounts`（或显式 `-q A -q B`），为每个启用账号 spawn 一个 boot
进程；boot 退出且 `autoRestart=true` 时延迟重启。

### 启动自建宿主

`launchSelfHost`：

1. 检查 `dist/host/self-host.cjs` 存在；Windows 校验 stub 目录下的 `QQNT.dll`
   （`--stub-dir` / `NAPUTO_STUB_DIR` 可覆盖），Linux 校验 `libnapuketto_stub.so`
   （`NAPUTO_LINUX_STUB` 可覆盖）与系统 `libgnutls.so.30`。
2. 按平台准备 Node：Windows 用本机 Node（非 Node 宿主时解析真 `node.exe`），Linux 直接用
   系统 `node`；构造 `NAPUTO_*` 入口/路径/账号变量，Windows 前置 stub 目录到 `PATH`，
   Linux 注入 `LD_PRELOAD` 与受管 `HOME`/`XDG_*`。
3. spawn 宿主；捕获 spawn `error`，避免命令缺失把父进程带崩。

### 宿主内引导

`self-host.cjs`（`src/host/core/self-host.ts` 打成单文件 CJS bundle）：

1. `NAPUTO_IPC=1` 时启用 JSON 行 IPC 并上报 `booting`；随后取账号目录实例锁，失败即退出。
2. 校验 `NAPUTO_WRAPPER_PATH`，`process.dlopen` 加载 `wrapper.node`；检查 exports 至少含
   `NodeIKernelLoginService`，并调 `NodeIO3MiscService.get().addO3MiscListener(...)` 激活
   事件分发（不激活会导致 `getLoginList` 永不 resolve）。
3. 动态 import kernel；从 `major.node` 解析 appid（失败即报错）；`NapukettoCore.create` →
   `attachWrapper`：在 `engine.initWithDeskTopConfig` **之前**创建 session
   （`StartupSessionWrapper.create` / `getNTWrapperSession`），顺序反了登录后
   `onOpentelemetryInit` 不触发。
4. 登录 → 激活 session → 等 `getMsgService` 就绪 → 创建 kernel 业务服务（事件通道与桥、
   `GroupCache`、`BuddyCache`、各 API、消息日志、在线状态）。
5. 装配协议（非 IPC）或挂 IPC 动作表（IPC）；成功后常驻（IPC 上报 `ready`）。
6. 任一步失败：返回 `false` 并退出，IPC 额外上报 `failed`；supervisor 按 `autoRestart`
   决定是否重启，单账号直接退出。

## QQ 原生文件来源

`resolveQqFiles` 按优先级定位 `wrapper.node`：

| 级别 | 来源 | 说明 |
|---|---|---|
| L0 | `NAPUTO_QQ_FILES` / `qqFilesDir` | 显式文件根，结构 `<root>/versions/<版本>/resources/app/wrapper.node` |
| L1 | 本机 QQ 安装 | `--qq-path` / `NAPUTO_QQ_PATH` > 注册表 > 常见安装路径 |
| L2 | 数据根缓存 | `<数据根>/qq-files/<版本>/`（下载解包产物） |
| 兜底 | 自动下载 | `packages/loader/qq-releases.json` 当前平台条目 → 下载 → sha256 → 7z 解包 |

- **不内置腾讯二进制**：安装包只在运行时下载到数据根；清单条目按 `platform` / `arch` 过滤，
  避免 Windows 选中 Linux deb。
- Windows 解 exe；Linux 下载官方 deb，`7zz` 三层解包（deb → data.tar[.xz] → 文件树），提取
  `wrapper.node` / `major.node` / `*.so*` / `sharp-lib/` 到同一缓存布局。
- 下载 URL 经 `normalizeDownloadUrl` 归一化：腾讯 CDN 边缘 WAF 对 `/QQNTV2/` 大小写敏感，
  请求前转小写 `/qqntv2/`。
- 清单由 `.github/workflows/update-qq-releases.yml` 维护；`NAPUTO_7Z_PATH` 可覆盖解包工具。
## 登录与 session

`NapukettoCore.login`：

1. `loginService.initConfig`。`commonPath` 必须指向 QQ 真实数据目录
   （`<QQ 用户数据根>/nt_qq/global`），否则快速登录列表为空。Windows 数据根来自
   `getNTUserDataInfoConfig()`；Linux 固定用 `<数据根>/nt_qq`，loader 把子进程
   `HOME`/`XDG_*` 收敛到 `<数据根>/home`，管住 `libbugly` 崩溃文件等残余写入。
2. 先 `connect()` 等 `onLoginConnected` 再留短暂缓冲；快速登录默认选第一个可用账号
   （`-q` / `NAPUTO_QUICK_UIN` 可指定），单步有超时兜底。
3. 快速登录失败 → 二维码登录（`qrFallback`）：PNG 写 `cache/qrcode.png`，日志打印 URL，
   CLI 渲染二维码，IPC 经 `qr` 消息转发；`qrOnly` 跳过快速登录。

登录成功后：构造 `sessionConfig`（`accountPath` 指 `nt_qq/global`，`downloadPath` 指其下
临时目录，`machineGuid` 来自 `getMachineGuid()`）→ `session.init` → **随后**
`startupSession.start()`（无则 `startNT`，顺序反了业务 service 不挂载）→ 等
`onOpentelemetryInit(true)` 或 `onSessionInitComplete(0)`（超时按失败）→ 轮询
`getMsgService()` 非空，确认 READY 后才建业务 API 与缓存。

## 数据流

### 调用链（第三方 → QQ）

```
第三方 HTTP/WS 请求
  → network 传输（HttpServer / WsServer / WsClient）
  → adapter 协议层（OB11 / Satori / Milky 动作分发）
  → BaseAction：zod 校验 → 动作实现
  → kernel 业务 API（统一错误语义）
  → wrapper.node 原生服务
```

kernel 抛 `KernelError`（带 `KernelErrorCode`）；协议层只维护“错误码 → 协议 retcode/HTTP
状态”映射，不解析底层错误。

### 事件链（QQ → 第三方）

```
wrapper.node 原生回调
  → kernel 事件桥（每个 Service 只注册一次原生 listener）
  → 类型化事件通道 NTEventChannel（事件名 "Service/method"）
       ├─ 协议适配器订阅：翻译为协议事件（纯函数，只读入参/缓存）
       ├─ 缓存订阅：GroupCache / BuddyCache 主动维护
       └─ 消息日志订阅：控制台/文件输出
  → network EventBroadcaster（每协议一个）
  → 本协议自己的 HTTP/WS/SSE 传输广播
```

单个订阅者抛异常不打断其他订阅者：`NTEventChannel.emit` 与 `EventBroadcaster.emit` 都逐
订阅者 `try/catch`。

### 协议隔离

`assemble-protocols` 为每个启用协议各建一个 `EventBroadcaster`（OB11 / Satori / Milky；
Kurobot 是纯出向协议，无第三方接入门面，不需要广播器）。多协议同时启用也互不串台：OB11
端口只有 `post_type` 信封，Satori 端口只有 `op/body` 信封。可选协议一律「账号协议段非空
才装配」：未配置的不实例化、不订阅、不占端口。IPC 模式的 OB11 出口是独立链路
（`ipc-ob11.ts` 自己的广播器 → `sendEvent("ob11", ...)`）。

**缓存层**：`GroupCache` 订阅群列表/详情/成员事件主动更新，未命中经 `GroupApi` 惰性回填并
对并发回填去重；`BuddyCache` 把 `Buddy/onBuddyListChange` 全量快照与上一帧对比，产出
`onBuddyAdded` / `onBuddyRemoved`（首帧只建 baseline）。协议翻译层只读缓存，不在翻译函数里
发请求，因此翻译是纯函数，可并行、可单测。

## 多账号与生命周期

- 一个账号一个 boot 子进程，再拉起自己的宿主；账号间不共享运行时对象。`autoRestart`
  （默认 true）与 `restartDelayMs`（默认 2000ms）控制崩溃重启；SIGINT/SIGTERM 停止全部
  子进程，超时未退则父进程强制退出。
- `<账号目录>/instance.lock` 记录 pid + 启动时间 + 命令行摘要，同账号目录只允许一个实例。
  pid 被复用（cmdline 不匹配）或查不到命令行时允许接管；旧锁无 cmdline 字段时保守判占用，
  需手动删锁（见 [operations.md](../guides/operations.md)）。
- `runtime.json`、`supervisor.json` 供 `status/stop/restart` 读取；进程存活以 pid 探测修正，
  不只看文件里的 `running`。

**IPC 模式**：`NAPUTO_IPC=1` 时宿主不装配 HTTP/WS 协议传输，stdout 只输出 JSON 行协议，
stdin 接收 `action` / `control` / `ping`；pino console 关闭，文件日志照常。`control login`
支持指定账号/强制扫码，已就绪时走“软重登”：清理旧协议/桥/缓存 → 用新登录结果重跑装配链，
不重启进程。Koishi 适配器（独立仓库）通过此协议驱动宿主；普通 CLI 部署不需要 IPC。

## 失败语义
- 引导失败**不留在常驻态**：`bootstrap` 返回 false → 上报 `failed` 并退出，避免父进程把
  “假 ready”当成可用实例。
- CLI 接管子进程 stdout/stderr 并过滤原生噪音；IPC 模式 stdout 专用于协议行。非 Node 宿主
  必须由 loader 解析出真正的 `node.exe`；协议装配失败在 CLI 模式视为引导失败。
