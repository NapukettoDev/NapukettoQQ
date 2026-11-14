# @napuketto/loader

> `@napuketto/loader` 管 QQ 原生文件的定位/下载/解包、stub 校验、自建宿主拉起、实例锁与
> IPC 通道；不管协议语义与业务 API（那在 kernel/adapter）。源码入口
> [`../src/index.ts`](../src/index.ts)，子进程入口 [`../src/host/core/self-host.ts`](../src/host/core/self-host.ts)。

## 核心机制

```text
launchSelfHost（调用进程）
  ├─ qq/      L0–L2 定位 → 版本清单 → 下载(https + sha256) → 解包(7z / 7zz) → 缓存
  ├─ boot/    平台分支：win32 PE stub ｜ linux .so + LD_PRELOAD
  └─ spawn    标准 node 跑 self-host.cjs，env 注入 NAPUTO_*
self-host（宿主子进程）
  ├─ lifecycle/ 实例锁 → 停止哨兵 / 信号
  ├─ dlopen wrapper.node → O3MiscService 激活事件分发
  └─ host/core  kernel 动态 import → 登录 → session → 协议装配 ｜ IPC
```

### QQ 文件来源与管线

```text
L0 NAPUTO_QQ_FILES：显式文件根（含 versions/ 结构）
L1 本机安装：NAPUTO_QQ_PATH → Linux NAPUTO_QQ_DIR > /opt/QQ → 注册表 / 常见路径
L2 <数据根>/qq-files/<版本>/：下载解包产物，扫描最新可用版本
L0–L2 全失败 → 自动下载解包；autoDownload=false 时直接报错
```

- 版本选择：`latestRelease` 先按 `platform`/`arch` 过滤再取末条；`version` 既是缓存目录名
  也是 `app_version`，Linux 另记 `coreVersion`（清单 schema 2，`qq-releases.json` 为纯文本）。
- 下载：Node 内置 `https` + `crypto`，流式 sha256、302 最多 5 跳、60s 无数据超时、完成后
  stat 兜底；`NAPUTO_QQ_URL` 覆盖清单 URL；临时文件带 pid + 时间戳保证并发隔离。
- URL 归一化：`normalizeDownloadUrl` 在唯一出站口把路径段 `/QQNTV2/` 降为 `/qqntv2/`
  （CDN 边缘对该段大小写敏感，大写必 403）；清单仍存官方原样 URL。
- Windows 解包：官方 exe 是 NSIS，必须完整版 `7z`（`7za` 不支持）；产物在 `Files/`，
  只提 `resources/app` 顶层 `*.node` + `*.dll`。
- Linux 解包：官方 deb 三层（deb → data.tar.xz → data.tar）；白名单 `*.node` / `*.so` /
  `*.so.N` + `pub.key` / `cacert.pem` / `package.json` / `application.json`，`sharp-lib/`
  整体保留；跳过 `avsdk/`、`resource/`、`application.asar`。
- 缓存布局固定为 Windows 同构的 `<版本>/versions/<版本>/resources/app/`，kernel 的
  wrapper 路径解析（ADR-018）无需平台分支。
- 7-Zip 选择：`NAPUTO_7Z_PATH` > 内置资产（x64；缺失时数据根缓存 / 官网兜底）> 系统
  PATH（`7zz` → `7z`）；Linux 非 x64 跳过内置（内置 `7zz` 是 x86-64 ELF），缺系统 7-Zip
  时抛安装指引。

### 平台分支

Windows：

- stub 校验：`native/build/stub-test-env/QQNT.dll`（`--stub-dir` 或 `NAPUTO_STUB_DIR`
  覆盖），缺失在 spawn 前抛错。
- 环境：PATH 前置 stub 目录 + `wrapper.node` 目录，并注入 `NAPUTO_STUB_DIR`。
- 入站图片自动下载补丁（issue #105，2026-11-14）：stub 私有组件在 wrapper 加载后
  运行期放行 QQ 原生收图管线（零磁盘篡改；版本特征失配自动降级，绝不盲写内存）。
  `LaunchOptions.nativeMediaPatch`（缺省 true）控制；状态 JSON 落
  `<账号数据目录>/media-patch-status.json`，self-host bootstrap 完成后读一次记日志
  （pending 时 45s 复读一次）。机制细节只在私有 `native/` 子模块。
- 宿主 node：`process.execPath` 是 node 直接用；非 Node 宿主（Bun/koishi CE）按
  `NAPUTO_WIN_NODE_PATH` > 系统 `where node` > `ensureWinNode` 下载缓存解析真 `node.exe`
  ——bun.exe 进程内没有该模块，`LoadLibrary` 报 1114。

Linux：

- stub：`native/build/linux-<arch>/libnapuketto_stub.so`（`NAPUTO_LINUX_STUB` 覆盖），
  预加载 `LD_PRELOAD=<stub>:<libgnutls.so.30>`；gnutls 是 `libbugly` 的无 `DT_NEEDED`
  隐藏依赖。
- 宿主 node：`process.execPath` 是 node 直接用，否则 `which node`。
- HOME/XDG 收敛：`<数据根>/home`（`NAPUTO_LINUX_HOME` 覆盖；无数据根退到
  `<账号目录>/home`），`XDG_CONFIG_HOME` / `XDG_DATA_HOME` / `XDG_CACHE_HOME` /
  `XDG_STATE_HOME` 指到其下；`XDG_RUNTIME_DIR` 不接管（会话级目录）。
- spawn 前预检 stub / gnutls / node，缺失抛可读错误；child `error` 监听兜住异步
  ENOENT，不让宿主进程崩溃。
- `NAPUTO_LINUX_NATIVE` 已退役：Linux 恒走原生分支，设 `0` 只播报一句提示。

### launchSelfHost 环境变量契约

| 变量 | 必填 | 含义 |
|---|---|---|
| `NAPUTO_WRAPPER_PATH` | 是 | `wrapper.node` 绝对路径（dlopen 目标） |
| `NAPUTO_KERNEL_ENTRY` | 是 | kernel 入口 `.mjs`，运行期动态 import |
| `NAPUTO_CFG_DIR` | 是 | 账号数据目录（实例锁 / boot 日志 / 配置兜底） |
| `NAPUTO_QQ_PATH` | 是 | QQ 入口路径（cached 来源为语义占位） |
| `NAPUTO_QQ_VERSION` | 是 | 版本目录名，即 `app_version` |
| `NAPUTO_SELF_HOST` | 否 | `1` = 自建宿主分支 |
| `NAPUTO_STUB_DIR` | 否 | stub 目录（诊断与 PATH 装配） |
| `NAPUTO_ADAPTER_ENTRY` | 否 | adapter 入口 `.mjs`（协议装配） |
| `NAPUTO_NETWORK_ENTRY` | 否 | network 入口 `.mjs`（协议装配） |
| `NAPKETTO_CONFIG` | 否 | 全局配置路径（`napuketto.toml`） |
| `NAPUTO_QUICK_UIN` | 否 | 强制快速登录账号（cli `-q`） |
| `NAPUTO_QR_ONLY` | 否 | `1` = 跳过快速登录强制扫码 |
| `NAPUTO_IPC` | 否 | `1` = IPC 子进程模式 |
| `NAPUTO_DATA_ROOT` | 否 | 数据根（停止哨兵；调用方 `extraEnv` 注入） |
| `NAPUTO_DISABLE_MEDIA_PATCH` | 否 | `1` = stub 跳过入站图片自动下载补丁（killswitch；`nativeMediaPatch: false` 注入，2026-11-14 issue #105） |
| `NAPUTO_MEDIA_PATCH_STATUS` | 否 | 补丁状态文件路径（恒注入 `<账号数据目录>/media-patch-status.json`；stub 写 JSON，self-host 读后记日志） |

- 子进程 `cwd` 缺省由调用方指向数据根：QQ 原生层在账号上下文就绪前会 fallback 到进程
  cwd 落盘。
- `stdio` 缺省 `inherit`；cli 接管 pipe 后逐行过滤 wrapper 原生噪音。
- `onStage` 回调覆盖 stub 校验 / node 解析 / 下载 / 解包 / 提取 / spawn 各阶段提示。

### 实例锁与进程治理

- 锁文件 `<账号数据目录>/instance.lock`，内容 `{pid, startedAt, cmdline}`。
- 判定：无锁或损坏 → 可启动；PID 不存活 → 崩溃残留，接管；存活则比对 cmdline
  （Windows `Get-CimInstance Win32_Process`，Linux `/proc/<pid>/cmdline`），查不到或不
  一致 → PID 已被复用，接管；旧锁无 cmdline → 保守判占用。
- 占用时 self-host 记日志、IPC 发 failed（`INVALID_STATE`）后 exit 1。
- 退出清理只在持有者是本进程时删锁；崩溃强杀残留由下次启动的探活兜底。
- 关停：`<数据根>/napuketto.stop` 哨兵（内容 `all` 或 uin，mtime 晚于进程启动才触发）
  与 SIGINT/SIGTERM/SIGBREAK，逆序跑关停钩子后 exit 0。

### IPC 模式与 OB11 容器

- `NAPUTO_IPC=1`：stdout 专用于 JSON 行协议 `{v, type, id?, payload}`（v=1），stdin 收
  action / control / ping；kernel console 日志关闭，避免撕裂协议行。
- 消息类型：status（booting/dlopening/logging/sessioning/ready/failed）、login、qr、
  event、result、log、ping/pong、action、control（stop/restart/login/status）。
- 登录前就启动 stdin 服务端（只含 `login.refreshQr`）；登录后 `attachIpcServices` 把
  kernel 点分动作并入同一张表，Msg/Group/Buddy/RecentContact/Login 五条通道转 event。
- 心跳 15s；`control status` 重播最近一条 status（父进程丢消息后重同步）。
- 编码统一 `encodeIpcMessage`：先 `toJsonSafe`（Map→对象、Set→数组、环引用丢分支）再
  stringify，否则 Map/Set 跨进程即丢。
- OB11 容器可选：IPC 模式且 `NAPUTO_ADAPTER_ENTRY` + `NAPUTO_NETWORK_ENTRY` 已注入时，
  `attachOb11IpcBridge` 动态 import adapter 子路径；`ProtocolConfig` 用 `parse({})` 作
  seed（不读写配置文件），`subscribeOnly()` 只订阅不启传输，动作名平铺进共享表（OB11
  snake_case 与 kernel 点分命名不冲突），事件经 `sendEvent("ob11", post_type, [event])`
  透出；失败 fail-soft 降级为纯 kernel 动作面。

### 软重登相位机

```text
login-race ──竞速 settle──→ assembling ──装配成功──→ ready（软重登窗口）
     └────── 任一失败路径 ──────→ aborted（进程将退出）
```

| 相位 | control login 成功结果的处理 |
|---|---|
| login-race | 抢占初始竞速并接管装配链 |
| ready | 软重登：重装配后重播 ready |
| assembling / aborted | 忽略（只记日志） |

- login-race 的抢占结果是 `sendLogin(logged_in)` + 经 `preemptRef` 接管初始竞速；ready
  态重装配完成后重播 `status(ready)` 与 `login(logged_in, 新 selfInfo)`。
- 互斥 claim/release：在途登录或重装配期间的新指令直接忽略。
- 清理顺序：OB11 桥 stop（含动作表条目移除）→ `attachIpcServices` stop →
  `services.dispose()`（桥 / 缓存 / 消息日志退订，幂等）。
- 重装配失败：sendStatus(failed) + exit 1，交宿主重启循环回收。

### 协议装配：一协议一广播器

- OB11 / Satori / Milky 各自 `new EventBroadcaster()`，只传给对应 adapter 的
  `broadcaster` 选项；Kurobot 是出向纯客户端协议，无广播器。
- 可选协议「账号段非空才装配」：satori 段空返回 `null`，kurobot / milky 同范式。
- IPC 桥的广播器在进程边界上独立，与 CLI 协议装配互不影响。

### 内联配置与退出码

- 来源优先级：`NAPKETTO_CONFIG_JSON` > `NAPKETTO_CONFIG` > `<账号目录>/napuketto.toml`。
- 内联生效时零 toml 读写，`cfgFile` 返回哨兵 `"<inline>"`；坏内联回退文件形态并记日志
  （cli 主路径已在拉起前校验）。
- 协议段 seed 的 zod 失败包装为 `ConfigError`（按错误名复刻 kernel 契约，不静态依赖
  kernel），沿 `startProtocols` → `bootstrap` 重抛，self-host 以 78（EX_CONFIG）退出。
- 其余引导失败 exit 1；请求式关停 exit 0。宿主用 78 区分「配置未就绪」与运行时崩溃。

## 跨包契约

- 编译期只依赖 zod；kernel / adapter / network 一律运行期 `import(file://…)`，接口面在
  `../src/host/types.ts` 与各模块内声明最小面，不新增 workspace 依赖（依赖方向红线）。
- `NAPUTO_KERNEL_ENTRY` 指向 kernel 构建产物；loader 只用其语义化能力
  （`NapukettoCore` / `startNapuketto`、`resolveAppidQua`、`quickLogin`、
  `initAndStartSession`、`resolveQqUserDataRoot` / `resolveQqGlobalPath`、`PathWrapper`
  等），能力探测失败即判引导失败，不在本层实现业务。
- 错误传播：`ConfigError` → 78；其余异常在 bootstrap 链收敛为 `false` → self-host
  exit 1，原因写 `<账号目录>/napuketto-boot.log`；IPC 模式另发 failed（`NOT_LOGIN` /
  `INVALID_STATE` / `INVALID_PARAM` / `UNKNOWN`）。
- 公共出口 [`../src/index.ts`](../src/index.ts)：`launchSelfHost`、`resolveQqFiles`、
  `ensureQqFiles`、解包与清单原语、实例锁、关停、IPC schema（zod 单一来源，koishi
  插件 import 同一份）。
- 进程拓扑：`apps/cli` 或 koishi 插件 → `launchSelfHost` → 每账号一个 self-host；
  Docker 部署形态见 [`docker.md`](../../../docs/guides/docker.md)。

## 关键取舍与不变量

1. **不内置腾讯二进制**：npm 包、镜像、仓库都不得含 `wrapper.node`、`QQNT.dll`、官方
   安装包（含压缩/编码形态）；只放自研 stub 与纯文本 `qq-releases.json`。
2. **零磁盘篡改**：只读加载 `wrapper.node`，绝不改写 QQ 安装目录任何文件；升级/卸载
   零残留。
3. **Windows/Linux 各一条路线**：Windows 用 PE stub `QQNT.dll`；Linux 用原生 ELF +
   `.so` stub + `LD_PRELOAD`。Wine 已退役（[ADR-027](../../../docs/architecture/decisions.md)），
   不复活 Windows `node.exe` 或 `Z:\` 路径映射。
4. **业务不进 loader**：登录、会话、协议语义属 kernel 与 adapter；loader 只做定位、
   拉起、进程治理与通道。
5. **一个账号数据目录只允许一个实例**：锁是硬约束，不提供绕过开关。
6. **退出码是契约**：0 请求式退出、1 运行时失败、78 配置未就绪，不得改语义。
7. **协议事件不得共用广播器**：新增协议必须自建 broadcaster。
8. **逆向产物只在私有 `native/` 子模块**：公共包与公共文档不得出现地址类数据。

探针命令与原始样本（dlopen、解包、实例锁、IPC）见 [evidence.md](./evidence.md)；
Linux 选型与历史取舍见 [decisions.md](../../../docs/architecture/decisions.md)。stub 符号面、
arm64 缺口与 Linux 探针细节在私有 `native/docs/`，公共侧只保留机制摘要。
