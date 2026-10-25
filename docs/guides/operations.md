# 运维与排障

## 1. 一个账号只能有一个实例

QQ 原生层（MMKV、登录单例、数据库）以账号数据目录为锁。同一账号启动第二个宿主时，
后启动者通常卡在 `loginService.initConfig` 之后无响应，或被踢下线。

规则：

- 任何要登录某账号的 probe、E2E、临时实例，先停掉常驻实例。
- 同一账号的数据目录只允许一个自建宿主；`instance.lock` 是兜底。
- supervisor 在跑且 `autoRestart=true` 时，`stop -q <uin>` 停掉的账号会被自动拉起；
  要彻底停止先停 supervisor。

## 2. 停启与状态

```bash
napuketto status                 # supervisor + 各账号状态
napuketto status -q <uin>        # 只看指定账号
napuketto stop                   # 停 supervisor + 全部账号（树杀）
napuketto stop -q <uin>          # 只停单账号（supervisor 可能自动拉起）
napuketto restart                # 重启 supervisor 全量
napuketto restart -q <uin>       # 重启单账号
```

- 状态来源：`<数据根>/<uin>/runtime.json`、`<数据根>/supervisor.json`；读取时用 pid 存活
  探测修正，不只看文件里的 `running`。
- `stop`/`restart`（2026-10-25 优雅化）：先写**停止哨兵** `<数据根>/napuketto.stop`
  （`stop -q` 写目标账号，无 `-q` 写 all）→ 等进程链自行有序退出（退出码 0）→
  限时（8s）未退的残留按 `runtime.json` pid 树杀兜底（Windows `taskkill /T /F`，
  POSIX SIGTERM）。
- `restart` 是 detached 拉起，日志不再接当前终端；到账号目录的 `logs/` 查看。

### 2.1 优雅关停契约（嵌入式宿主 / 脚本适用）

三层常驻进程（supervisor / boot / self-host）支持两种优雅停触发，宿主可任选：

1. **停止哨兵**（推荐，零平台依赖）：向 `<数据根>/napuketto.stop` 写文件，内容为
   目标账号 uin 或 `all`（空文件等同 all）。mtime 晚于进程启动才触发（陈旧哨兵
   无效，守护重启不误杀），每进程至多触发一次。
2. **信号**：SIGINT / SIGTERM / SIGBREAK。Windows 下 CTRL_BREAK_EVENT 以 SIGBREAK
   到达——宿主以 `CREATE_NEW_PROCESS_GROUP` 拉起后可用
   `GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, pid)` 优雅停整树。

退出码契约（2026-10-25 起，宿主消费的机器契约，与日志文案解耦）：

| 退出码 | 含义 | 宿主处置 |
|---|---|---|
| `0` | 请求式正常退出（哨兵/信号触发的有序关停，含内部清理：协议适配器停止、事件桥退订、日志落盘） | 无需动作 |
| `78` | 配置校验失败（EX_CONFIG 惯例：占位值 / 必填缺失 / 形状非法 / 内联 JSON 坏值，含协议段装配期 zod 校验） | **不重启**——配置不修，重启无意义；修配置后再拉起 |
| 其余非 0 | 引导失败或运行时致命（协议 / 网络 / 原生层意外） | 按既有退避策略处理 |

判定只认错误类型（kernel `ConfigError` 一族），日志文案不参与机器判定。
`taskkill /F` 强杀仍产出退出码 1（无法区分崩溃，宿主应优先用哨兵通道）。
拉起前可用 `napuketto config validate` 预检（exit 0 合法 / 78 校验失败 / 1 用法错误）。

## 3. 日志与状态文件

| 文件 | 内容 |
|---|---|
| `<账号目录>/logs/napuketto.log` | kernel pino 文件日志（登录、session、API、协议装配） |
| `<账号目录>/logs/loader.log` | loader 业务日志、消息日志、协议校准原始数据 |
| `<账号目录>/napuketto-boot.log` | 引导阶段纯文本日志；引导失败的根因通常在这里 |
| `<账号目录>/runtime.json` | 账号 boot 进程 pid、self-host pid、启动时间、重启次数、退出码 |
| `<数据根>/supervisor.json` | supervisor pid、启动时间、账号列表 |
| `<账号目录>/cache/qrcode.png` | 二维码登录图片 |

CLI 会逐行转发子进程 stdout/stderr，并过滤 wrapper 原生噪音（MMKV 刷屏、标准 Node 缺少
腾讯私有符号的加载警告）。IPC 模式 stdout 只用于 JSON 行协议，pino console 已关闭。

## 4. 常见故障

### 4.1 “数据目录已被其他实例占用”

1. 确认是否有另一个 bot/koishi/probe 正在跑同一账号。
2. 停掉旧实例；supervisor 场景先 `napuketto stop`。
3. 若确认旧实例已死，检查 `<账号目录>/instance.lock`。新锁带 pid + 命令行摘要，pid 已死或
   pid 被复用时启动会自动接管。
4. **旧版锁没有 cmdline 字段**：无法校验，保守判占用；手动删除 `instance.lock` 后重试。
5. 需要验证锁链路时（先构建 loader）：

```bash
node packages/loader/scripts/verify-lock.mjs
```

### 4.2 启动即退出 / 登录挂起

- 先看 `<账号目录>/napuketto-boot.log` 的最后一段。
- 快速登录可能被风控挂起：用 `-q <uin>` 指定账号，或走扫码登录。
- 同账号已有会话未退：按 §1 停旧实例。
- 二维码登录：CLI 会在终端渲染二维码，PNG 落在 `cache/qrcode.png`；IPC 模式下由前端展示。
- 登录失败不会留驻：引导进程会退出，supervisor 按 `autoRestart` 决定是否重启。

### 4.3 `stub QQNT.dll 未找到` / `dlopen` 失败

- 确认 `packages/loader/native` 子模块已检出，或显式传 `--stub-dir` / `NAPUTO_STUB_DIR`。
- stub 目录必须包含 `QQNT.dll`；启动时该目录与 `wrapper.node` 所在目录会被前置到 `PATH`。
- 宿主必须是真正的 Node：Bun 等运行时下 `wrapper.node` 的符号绑定会失败，loader 会尝试
  找系统 `node.exe` 或下载 Windows 版 Node。
- Linux/WSL：确认 wine 已安装（`wine --version`）；所有路径会被转成 `Z:\`，`PATH` 必须是
  纯 Windows 风格（分号分隔）。wine 缺失时 loader 会在 spawn 前给出安装提示。

### 4.4 QQ 文件定位/下载失败

- 优先级：`NAPUTO_QQ_FILES` → 本机安装（`NAPUTO_QQ_PATH` / 注册表 / 常见路径）→
  `<数据根>/qq-files` 缓存 → 自动下载。
- 下载失败先看网络与磁盘空间；可用 `NAPUTO_QQ_URL` 指定可用安装包地址。
- 官方 URL 的 `/QQNTV2/` 路径段会被 CDN 边缘 WAF 大小写敏感拦截，loader 已统一归一化为
  `/qqntv2/`；若仍 403，更新 `packages/loader/qq-releases.json` 或本地跑
  `node tooling/qq-releases/update-qq-releases.ts`。
- `无法从 major.node 解析 appid`：通常是 QQ 文件不完整（缺 `major.node`）或版本目录结构
  异常；重新下载/更新清单，不要写死 appid。
- 解包失败时检查 7-Zip：`NAPUTO_7Z_PATH` 可指定可执行文件；Linux 内置 `7zz`，缺失时回退
  下载，需要 `tar` + `xz-utils`。

### 4.5 收不到实时消息

- 查日志中的“在线状态注册失败（实时消息推送可能不可用）”。自建宿主启动后会主动调用
  `setOnlineStatus`；失败只影响推送，不影响发送。
- 确认 session READY（`getMsgService` 可用）且协议传输已监听。
- 检查是否被同账号另一端顶下线。

### 4.6 stderr 原生噪音

- `<MMKV...`、`loadSymbolFromShell`、`get symbol failed`、`loaded [mmkv...]` 等是 wrapper
  原生 printf 输出，CLI 与 Koishi IPC 都会过滤（`isNativeNoiseLine`）。
- `libprotobuf ERROR ... OpenTelemetry ... invalid UTF-8` 是 QQNT 自身 OTel 导出器对消息体
  的噪音，**零功能影响**，目前不过滤。排查其他 stderr 报错时先排除这一条，不要当本框架 bug。
- IPC 模式 stdout 只用于 JSON 行协议，pino console 已关闭；若行被原生输出插断，先检查是否
  有未过滤的原生输出。

### 4.7 Satori / OB11 传输端口冲突

- 每个传输实例独立监听；端口被占用时启动会失败。
- 同一账号的 OB11 与 Satori 默认端口不同（3000/3001 vs 5500/5501），多账号部署时自行错开。
- 鉴权失败：OB11 的 WS 以 4401 关闭；Satori HTTP 用 Bearer，WS 在 IDENTIFY 中带 token。
  token 为空表示不鉴权。

## 5. 诊断开关

| 开关 | 作用 |
|---|---|
| `NAPUTO_SMOKE=1` | 登录后真发/收一条消息做冒烟自检；`NAPUTO_SMOKE_PEER` 指定目标（`c2c:<uin>` / `group:<uin>`） |
| `NAPUTO_PROBE=1` | 启动时探测 session/service 方法面，写探测 JSON |
| `NAPUTO_LOG_LEVEL=debug` | CLI 日志更详细（文件日志级别不随之变化） |
| `NAPUTO_IPC=1` | 以 IPC 模式运行（Koishi 适配器等外部驱动使用） |

## 6. 上线前检查

- `pnpm check`、`pnpm test` 全绿；涉及发布包改动已跑 `pnpm -r build`。
- 配置中账号 `qq` 为真实号码，协议段端口不冲突，token 已改。
- 同账号没有残留实例；`runtime.json` 与真实进程一致。
- 日志无持续登录失败、无 `dlopen`/stub 错误、无 `setOnlineStatus` 失败。
