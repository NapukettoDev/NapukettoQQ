# 运维与排障

> 适用：单机自托管部署的启停、状态核对与故障定位。
> 前置：已按 [配置与路径](configuration.md) 写好 `napuketto.toml`；下文 `<数据根>` 默认
> `<项目根>/.napuketto`，`<账号目录>` 即 `<数据根>/<uin>`。

一个账号只允许一个宿主实例：QQ 原生层（MMKV、登录单例、数据库）以账号数据目录为锁，
第二个实例会卡在 `loginService.initConfig` 之后或顶掉先启动者。兜底锁
`<账号目录>/instance.lock`（pid、启动时间、命令行摘要）可接管已死或复用的 pid；旧锁无摘要时保守判占用，probe/E2E 前先停常驻实例。

## 操作步骤

1. 查看状态：`napuketto status`；只看单账号用 `napuketto status -q <uin>`。
2. 停止：`napuketto stop` 停 supervisor 与全部账号；`napuketto stop -q <uin>` 只停单账号。
3. 重启：`napuketto restart` 全量；`napuketto restart -q <uin>` 单账号。detached 拉起，输出
   不接当前终端；日志见 `<账号目录>/logs/` 与 `<账号目录>/napuketto-boot.log`。
4. 改配置后先预检：`napuketto config validate`，退出码见下文。

`stop -q` 后若 supervisor 仍在运行且 `autoRestart=true`，账号会被自动拉起；彻底停止请先 `napuketto stop`。

### 两种优雅停

- **停止哨兵**：向 `<数据根>/napuketto.stop` 写文件，内容为目标 uin 或 `all`（空文件等同 all），
  mtime 晚于进程启动才触发，每进程至多一次；`stop`/`restart` 先等 8 秒，未退再树杀（Windows `taskkill /T /F`，POSIX SIGTERM）。
- **信号**：SIGINT / SIGTERM / SIGBREAK；Windows 的 `CTRL_BREAK_EVENT` 以 SIGBREAK 到达，`CREATE_NEW_PROCESS_GROUP` 拉起后可优雅停整树。

### 退出码契约

| 退出码 | 含义 | 宿主处置 |
|---|---|---|
| `0` | 哨兵/信号触发的有序关停 | 无需动作 |
| `78` | 配置校验失败 | 不重启，先修配置 |
| 其他非 0 | 引导失败或运行时致命 | 按退避策略重启 |

- 判定只认错误类型（kernel `ConfigError`），与日志文案无关；supervisor 见 78 不自动重启。
- `taskkill /F` 强杀仍产出退出码 1，无法与崩溃区分，宿主应优先用哨兵通道。
- `config validate`：0 合法 / 78 校验失败 / 1 用法错误（`--config` 与 `--config-json` 同给）。

## 验证与常见排障

### 日志与状态文件

| 文件 | 内容 |
|---|---|
| `<账号目录>/logs/napuketto.log` | kernel 文件日志（登录、session、API） |
| `<账号目录>/logs/loader.log` | loader 业务/消息日志与协议校准 |
| `<账号目录>/napuketto-boot.log` | 引导阶段纯文本日志（失败根因常在此） |
| `<账号目录>/runtime.json` | 进程 pid、启动时间、重启数、退出码 |
| `<数据根>/supervisor.json` | supervisor pid、启动时间、账号列表 |
| `<账号目录>/cache/qrcode.png` | 扫码登录二维码图片 |

`status` 读状态文件后再用 pid 存活探测修正，不只看文件记录；CLI 逐行转发子进程
stdout/stderr 并过滤原生噪音（`isNativeNoiseLine`）；IPC 模式 stdout 只承载 JSON 行协议，pino console 关闭。

### 诊断开关

| 开关 | 作用 |
|---|---|
| `NAPUTO_SMOKE=1` | 登录后真发/收一条消息自检 |
| `NAPUTO_PROBE=1` | 启动时探测 session/service 方法面 |
| `NAPUTO_IPC=1` | 以 IPC 模式运行（Koishi 适配器等外部驱动） |
| `NAPUKETTO_LOG_LEVEL=debug` | 调高日志级别（控制台与缺省文件级别） |

`NAPUTO_SMOKE_PEER` 指定冒烟目标（`c2c:<uin>` / `group:<uin>`）。日志级别优先级：
`NAPUKETTO_LOG_LEVEL` > 旧拼写 `NAPKETTO_LOG_LEVEL` > `[log].level`；显式 `[log.file].level` 不跟随。

### 实例锁占用

- 确认是否有另一个 bot、Koishi 或 probe 在跑同一账号，先停旧实例；supervisor 场景执行
  `napuketto stop`。新锁会按 pid 与命令行摘要自动接管，旧锁无摘要时删除 `<账号目录>/instance.lock` 后重试。

### 启动即退 / 登录挂起

- 先看 `<账号目录>/napuketto-boot.log` 的最后一段。
- 快速登录可能被风控挂起：用 `-q <uin>` 指定账号，或改扫码登录。
- 扫码登录：CLI 在终端渲染二维码，PNG 落在 `<账号目录>/cache/qrcode.png`，IPC 模式由前端展示。
- 登录失败不留驻：引导进程退出，supervisor 按 `autoRestart` 决定是否重启。

### stub 或 dlopen 失败

- 确认 `packages/loader/native` 子模块已检出，或用 `--stub-dir` / `NAPUTO_STUB_DIR`
  指定含 `QQNT.dll` 的目录；stub 目录与 `wrapper.node` 所在目录会前置到 `PATH`。
- 宿主必须是真正的 Node：Bun 等运行时符号绑定会失败，loader 会改用系统 `node.exe`
  或下载 Windows 版 Node。
- Linux 见下文 Linux 原生宿主。

### QQ 文件定位或下载失败

- 定位优先级：`NAPUTO_QQ_FILES` → 本机安装（`NAPUTO_QQ_PATH` / 注册表 / 常见路径）→
  `<数据根>/qq-files` 缓存 → 自动下载；下载失败先查网络与磁盘，可用 `NAPUTO_QQ_URL`
  指定安装包地址。
- 官方 URL 的 `/QQNTV2/` 段会被 CDN 按大小写拦截，loader 已统一为 `/qqntv2/`；仍 403
  时更新 `packages/loader/qq-releases.json` 或跑 `tooling/qq-releases/update-qq-releases.ts`。
  追踪 issue 只代表 Windows 侧或配置解析失败；Linux deb 的旧版配置与下载失败只 warn。
- 报 `无法从 major.node 解析 appid`：多为 QQ 文件不完整，重新下载，不要写死 appid。
- 解包失败检查 `NAPUTO_7Z_PATH`；Linux 内置 `7zz`，回退下载需 `tar` + `xz-utils`。

### 收不到实时消息

- 日志出现「在线状态注册失败（实时消息推送可能不可用）」：`setOnlineStatus` 失败只影响
  推送，不影响发送。
- 确认 session 已 READY（`getMsgService` 可用）且协议传输已监听。
- 检查是否被同账号另一端顶下线。

### stderr 原生噪音

- `<MMKV...`、`loadSymbolFromShell`、`get symbol failed`、`loaded [mmkv...]` 等是 wrapper
  原生 printf 输出，CLI 与 Koishi IPC 都会过滤（`isNativeNoiseLine`）。
- `libprotobuf ERROR ... OpenTelemetry ... invalid UTF-8` 是 QQNT 自身 OTel 导出器噪音，
  零功能影响且目前不过滤；排查其他 stderr 报错前先排除它。
- IPC 模式 stdout 只承载 JSON 行协议，pino console 已关闭；行被插断时先查未过滤的原生输出。

### Satori / OB11 端口冲突

- 每个传输实例独立监听，端口被占用时启动失败。
- OB11 默认 3000/3001、Satori 默认 5500/5501；多账号部署自行错开。
- 鉴权失败：OB11 的 WS 以 4401 关闭；Satori HTTP 用 Bearer、WS 在 IDENTIFY 带 token；token 空表示不鉴权。

### Linux 原生宿主

Linux 只有一条路线：标准 `node` + 最小 `.so` stub + 官方 ELF `wrapper.node`（`LD_PRELOAD=libnapuketto_stub.so:libgnutls.so.30`）。
Wine 路径已删除，`NAPUTO_LINUX_NATIVE` 与 `NAPUTO_WINE` 均失效；机制见
[linux-native-host.md](../architecture/linux-native-host.md)。

| 依赖 | 作用 | 缺失症状 |
|---|---|---|
| `libgnutls.so.30` | libbugly 隐藏依赖，必须 preload | 启动报未找到或 gnutls 符号错 |
| `libx11-6` 等 X11 库 | wrapper.node 的 DT_NEEDED | dlopen 报 libX11.so.6 缺失 |
| `libuuid1` | arm64 的 wrapper.node 缺 uuid 依赖 | 首次 uuid_generate 报符号错误 |
| 内置 `7zz` | deb 解包 | 解包阶段报 7-Zip 错误 |

Ubuntu 24.04 的 gnutls 包名是 `libgnutls30t64`，Debian 12 是 `libgnutls30`；X11 需要
`libx11-6`、`libx11-xcb1`、`libxext6`、`libxcb1`。排障顺序：

- 报「Linux stub 未找到」→ 用 `NAPUTO_LINUX_STUB` 指向包内可用的 `.so`。
- 报 gnutls 相关 → 安装系统包后重试（loader 会自动 preload）。
- `dlopen` 报缺 `.so` → 按上表补齐系统库。
- 仍失败 → `ldd <wrapper.node>` 对照 [linux-native-host.md](../architecture/linux-native-host.md) 依赖清单。

`HOME` 与 `XDG_CONFIG_HOME` / `XDG_DATA_HOME` / `XDG_CACHE_HOME` / `XDG_STATE_HOME` 收敛到
`<数据根>/home`（`NAPUTO_LINUX_HOME` 可覆盖，`XDG_RUNTIME_DIR` 不接管），崩溃记录在
`<数据根>/home/.config/QQ/crash_files/`；arm64 仅 qemu 验到加载与登录握手，交付只承诺 x64，`libuuid` 需手工 preload。

### 上线前检查

- `pnpm check`、`pnpm test` 全绿；发布包有改动时已跑 `pnpm -r build`。
- 账号 `qq` 为真实号码，协议段端口不冲突，token 已改。
- 同账号无残留实例；`status` 与真实进程一致。
- 日志无持续登录失败、无 `dlopen`/stub 错误、无 `setOnlineStatus` 失败。
