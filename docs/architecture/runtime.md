# 运行链路

本篇描述从命令到 QQ 原生调用、再到协议输出的完整运行链路。字段与默认值见
[configuration.md](../guides/configuration.md)；协议翻译细节见各协议文档。

## 1. 进程拓扑

```
CLI（node dist/index.mjs）
├─ 单账号：当前进程即 boot 进程
│    └─ 自建宿主子进程（node dist/host/self-host.cjs）
└─ 多账号：supervisor 进程
     └─ 每个账号一个 boot 子进程 → 各自一个自建宿主子进程
```

自建宿主进程内：

```
stub QQNT.dll（PATH 前置）
  └─ process.dlopen(wrapper.node)
       └─ kernel（engine / loginService / session）
            ├─ 事件通道 + 事件桥 + 缓存 + 业务 API
            ├─ adapter（onebot11 / satori）→ network 传输（HTTP / WS）
            └─ adapter（kurobot）→ 自带 WS 客户端
```

关键点：

- **没有 QQ 进程、没有注入、没有 UI**。标准 Node 通过 stub 转发 `wrapper.node` 需要的
  `napi_*` / `uv_*` / `qq_magic_*` 等宿主符号。
- Windows 上优先使用当前 Node（`process.execPath` 是 `node`/`node.exe`）。若宿主是 Bun 等
  非 Node 运行时，loader 会另找系统 `node.exe` 或下载 Windows 版 Node，再由它执行自建宿主。
- Linux 上用 wine 运行 Windows 版 `node.exe`；所有传给 wine 的路径都转成 `Z:\` 形式，
  `PATH` 必须是纯 Windows 风格（分号分隔），否则 stub 目录会丢失。
- 账号之间是进程隔离：一个账号一个自建宿主进程，天然满足 kernel“无全局单例”的前提。

## 2. 启动序列

### 2.1 CLI 准备

单账号入口 `runSingleAccount`：

1. 解析数据根（`--data-dir` > `NAPKETTO_DATA` > `<项目根>/.napuketto`）。
2. 解析账号数据目录：`<数据根>/<uin>`；未指定 `-q` 时为 `<数据根>/default`。
3. 定位 QQ 原生文件（见 §3），得到 `wrapperPath` 与版本。
4. 预检实例锁：账号目录已被存活实例占用则快速失败，提示占用 PID。
5. 解析 `@napuketto/kernel`、`@napuketto/adapter`、`@napuketto/network` 的 dist 入口。
6. 调 `launchSelfHost`；子进程 `cwd` 指向数据根（QQ 原生层在账号上下文就绪前可能向 cwd
   落盘），`NAPKETTO_CONFIG` 指向全局配置文件。

多账号入口 `runSupervisor` 读 `accounts`（或显式 `-q A -q B`），为每个启用账号 spawn 一个
boot 进程；boot 退出且 `autoRestart=true` 时延迟重启。

### 2.2 启动自建宿主

`launchSelfHost`：

1. 检查 `dist/host/self-host.cjs` 存在。
2. 检查 stub 目录下的 `QQNT.dll`；默认 `packages/loader/native/build/stub-test-env`，
   可用 `--stub-dir` / `NAPUTO_STUB_DIR` 覆盖。
3. 平台分支：Windows 原生 Node，或 Linux wine + Windows `node.exe`（需要时自动下载）。
4. 构造环境变量（`NAPUTO_QQ_PATH`、`NAPUTO_KERNEL_ENTRY`、`NAPUTO_CFG_DIR`、
   `NAPUTO_QQ_VERSION`、`NAPUTO_WRAPPER_PATH`、adapter/network 入口、配置路径、快速登录
   账号等），把 stub 目录与 `wrapper.node` 所在目录前置到 `PATH`。
5. spawn 自建宿主；捕获 spawn `error`，避免 wine 缺失等场景把父进程带崩。

### 2.3 宿主内引导

`self-host.cjs`（由 `src/host/core/self-host.ts` 打成单文件 CJS bundle）：

1. 若 `NAPUTO_IPC=1`，启用 JSON 行 IPC 并上报 `booting`。
2. 获取账号数据目录实例锁；失败则退出。
3. 校验 `NAPUTO_WRAPPER_PATH`，`process.dlopen` 加载 `wrapper.node`；检查 exports 至少含
   `NodeIKernelLoginService`。
4. 调 `NodeIO3MiscService.get().addO3MiscListener(...)` 激活事件分发。自建宿主没有 QQ 的
   事件分发对象，不激活会导致 `getLoginList` 永不 resolve。
5. 动态 import kernel；从 `major.node` 解析 appid（失败即报错，不再静默回退）。
6. `NapukettoCore.create` → `attachWrapper`：
   - 自建宿主在 `engine.initWithDeskTopConfig` **之前**创建 session（`StartupSessionWrapper.create`
     / `getNTWrapperSession`），顺序反了会导致登录后 `onOpentelemetryInit` 不触发。
   - 装配 engine、loginService、session 到 `CoreContext`。
7. 登录（见 §4）。
8. 登录成功后激活 session，等待 `getMsgService` 就绪。
9. 创建 kernel 业务服务：消息/群/好友事件通道与事件桥、`GroupCache`、`BuddyCache`、各 API、
   消息日志、在线状态。
10. 装配协议（非 IPC）或挂 IPC 动作表（IPC）；成功后常驻（IPC 模式上报 `ready`）。
11. 任一步失败：引导返回 `false` 并退出；IPC 模式额外上报 `failed`（若未上报更具体原因）。
    多账号 supervisor 模式按 `autoRestart` 决定是否重启；单账号直接退出。

## 3. QQ 原生文件来源

`resolveQqFiles` 按优先级定位 `wrapper.node`：

| 级别 | 来源 | 说明 |
|---|---|---|
| L0 | `NAPUTO_QQ_FILES` / `qqFilesDir` | 显式文件根，目录结构须为 `<root>/versions/<版本>/resources/app/wrapper.node` |
| L1 | 本机 QQ 安装 | `--qq-path` / `NAPUTO_QQ_PATH` > 注册表 > 常见安装路径 |
| L2 | 数据根缓存 | `<数据根>/qq-files/<版本>/`（下载解包产物） |
| 兜底 | 自动下载 | 读 `packages/loader/qq-releases.json` 的最新条目，下载官方安装包 → sha256 校验 → 7z 解包 → 提取 `wrapper.node` 及依赖 DLL 到 L2 |

约束与细节：

- **不在仓库或 npm 包内置腾讯二进制**。安装包只在用户机器运行时下载到数据根。
- 下载 URL 统一经 `normalizeDownloadUrl` 处理：腾讯 CDN 边缘 WAF 对字面量 `/QQNTV2/`
  路径段区分大小写拦截，请求前归一化为小写 `/qqntv2/`；源站本身大小写不敏感。
- 版本清单由 `.github/workflows/update-qq-releases.yml` 每日维护，也可本地跑
  `node tooling/qq-releases/update-qq-releases.ts` 兜底。
- cached 来源下 `qq.qqPath` 只是语义占位（缓存目录没有 `QQ.exe`），启动只消费
  `wrapperPath` 与版本。
- 解包工具：Windows 用内置 `assets/7zip/7z.exe`；Linux 用内置 `7zz`，缺失时回退数据根
  缓存或下载。`NAPUTO_7Z_PATH` / `NAPUTO_7Z_URL` 可覆盖。

## 4. 登录与 session

### 4.1 登录

`NapukettoCore.login`：

1. `loginService.initConfig`。`commonPath` 必须指向 QQ 真实数据目录
   （`<QQ 用户数据根>/nt_qq/global`），否则读不到历史账号、快速登录列表为空。
2. 自建宿主先 `connect()` 并等 `onLoginConnected`，再留短暂缓冲；不等连接直接快速登录会报
   “登录系统连接异常”。
3. 快速登录：默认自动选第一个可快速登录账号；`-q` / `NAPUTO_QUICK_UIN` 可强制指定。
   单步有超时兜底，避免服务端已有同账号会话时永久挂起。
4. 快速登录失败 → 二维码登录（`qrFallback`）。二维码 PNG 写到账号 `cache/qrcode.png`，
   日志打印 URL；CLI 从子进程标记行解析后在终端渲染二维码，IPC 模式经 `qr` 消息转发。
5. `qrOnly` 跳过快速登录，直接扫码（Koishi 面板“扫码登录”/切账号用）。

### 4.2 session 激活顺序

自建宿主登录成功后：

1. 构造 `sessionConfig`，`accountPath` 指向 QQ 的 `nt_qq/global`，`downloadPath` 指向其下
   临时目录；`machineGuid` 从 `loginService.getMachineGuid()` 读取。
2. `session.init(config, depends, dispatcher, listener)`。
3. **随后**调用 `startupSession.start()`（没有则回退 `startNT`）。顺序必须是先 init 后
   start；反过来业务 service 不会挂载。
4. 等 `onOpentelemetryInit(is_init=true)`（主信号）或 `onSessionInitComplete(0)`（辅信号），
   超时按失败处理。
5. 轮询 `getMsgService()` 非空，确认 session READY；之后才创建业务 API 与缓存。

## 5. 数据流

### 5.1 调用链（第三方 → QQ）

```
第三方 HTTP/WS 请求
  → network 传输（HttpServer / WsServer / WsClient）
  → adapter 协议层（OB11 / Satori 动作分发）
  → BaseAction：zod 校验 → 动作实现
  → kernel 业务 API（统一错误语义）
  → wrapper.node 原生服务
```

错误语义：kernel 抛 `KernelError`（带 `KernelErrorCode`）；协议层只维护“错误码 → 协议
retcode/HTTP 状态”的映射表，不解析底层错误。

### 5.2 事件链（QQ → 第三方）

```
wrapper.node 原生回调
  → kernel 事件桥（每个 Service 只注册一次原生 listener）
  → 类型化事件通道 NTEventChannel（事件名 "Service/method"）
       ├─ 协议适配器订阅：翻译为协议事件（纯函数，只读入参/缓存）
       ├─ 缓存订阅：GroupCache / BuddyCache 主动维护
       └─ 消息日志订阅：控制台/文件输出
  → network EventBroadcaster
  → 各 HTTP/WS 传输广播
```

单个订阅者抛异常不会打断其他订阅者：`NTEventChannel.emit` 与
`EventBroadcaster.emit` 都逐订阅者 `try/catch`。

### 5.3 缓存

- `GroupCache`：订阅群列表/详情/成员事件主动更新；查询未命中时经 `GroupApi` 惰性回填，
  并对并发回填做 in-flight 去重。
- `BuddyCache`：把 `Buddy/onBuddyListChange` 的全量好友快照与上一帧对比，产出
  `BuddyCache/onBuddyAdded` / `onBuddyRemoved` 归一化事件（首帧只建 baseline，不发事件）。
- 协议翻译层只读缓存，不在翻译函数里发请求；因此翻译是纯函数，可并行、可单测。

## 6. 多账号与生命周期

### 6.1 supervisor

- 一个账号一个 boot 子进程，子进程再拉起自己的自建宿主；账号之间不共享运行时对象。
- `autoRestart`（默认 true）与 `restartDelayMs`（默认 2000ms）控制崩溃重启。
- 收到 SIGINT/SIGTERM 时停止全部子进程；子进程超过时限未退出则父进程强制退出。

### 6.2 实例锁与状态文件

- `<账号数据目录>/instance.lock`：pid + 启动时间 + 命令行摘要。同账号目录只允许一个实例，
  避免 QQ 原生层（MMKV/登录单例）抢锁挂起。
- pid 存活但命令行摘要不匹配 → 视为 pid 被复用，允许接管；查不到命令行同样按“持有者已死”
  处理。旧锁没有 cmdline 字段时保守判占用，需要手动删锁（见
  [operations.md](../guides/operations.md)）。
- `<账号数据目录>/runtime.json`、`<数据根>/supervisor.json` 供 `status/stop/restart`
  读取；进程存活以 pid 探测修正，不只看文件里的 `running`。

### 6.3 IPC 模式

`NAPUTO_IPC=1` 时自建宿主不装配 HTTP/WS 协议传输，而是：

- stdout 只输出 JSON 行协议，stdin 接收 `action` / `control` / `ping`。
- pino console 关闭，避免与协议行交错；文件日志照常。
- IPC 版本 `1`；消息类型 `status` / `login` / `qr` / `event` / `result` / `log` / `ping` /
  `pong` / `action` / `control`。
- 动作名采用点分域（如 `msg.sendMessage`）；登录后把 kernel 服务动作并入同一张表。
  app 层注入 adapter/network 入口时，可再整表挂载 OB11 动作容器（只订阅事件，不装配网络）。
- `control login` 支持指定账号/强制扫码；已就绪时走“软重登”：
  清理旧协议/桥/缓存 → 用新登录结果重跑装配链，不重启进程。登录控制相位为
  `login-race` → `assembling` → `ready`（或 `aborted`），迟到结果不误报。
- `control status` 重播最近一条 status，供父进程丢失消息后重同步。

Koishi 适配器（独立仓库）通过此协议驱动宿主；普通 CLI 部署不需要 IPC。

## 7. 失败语义与约束

- 引导失败**不留在常驻态**：`bootstrap` 返回 false → 上报 `failed` 并退出，避免父进程
  把“假 ready”当成可用实例。supervisor 按 `autoRestart` 决定是否重启。
- CLI 模式接管子进程 stdout/stderr 并逐行过滤原生噪音；IPC 模式 stdout 专用于协议行。
- 非 Node 宿主（Bun 等）必须由 loader 解析出真正的 `node.exe`，否则 `wrapper.node` 的
  宿主符号绑定失败。
- 协议装配失败在 CLI 模式视为引导失败（跑宿主就是为了协议服务），不再 fail-soft。
