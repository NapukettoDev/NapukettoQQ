# @napuketto/loader

> `@napuketto/loader` 管 QQ 原生文件的定位/下载/解包、stub 校验、自建宿主拉起、实例锁与
> IPC 通道；不管协议语义与业务 API（那在 kernel/adapter）。源码入口
> [`../src/index.ts`](../src/index.ts)，子进程入口 [`../src/host/self-host.ts`](../src/host/self-host.ts)。

## 核心机制

```text
launchSelfHost（调用进程）
  ├─ artifacts/ L0–L2 定位 → 版本清单 → 下载(https + sha256) → 解包(7z / 7zz) → 缓存
  ├─ boot/      平台分支：win32 PE stub ｜ linux .so + LD_PRELOAD
  └─ spawn      标准 node 跑 self-host.cjs，env 注入 NAPUKETTO_*
self-host（宿主子进程）
  ├─ lifecycle/ 实例锁 → 停止哨兵 / 信号
  ├─ 动态 import kernel → dlopenWrapper → activateO3MiscService
  └─ host/     kernel 动态 import → 登录 → session → 协议装配 ｜ IPC
```

### 目录结构（依赖单向向下）

`src/` 下目录深度不超过 3 层（包根 `tests/` 镜像 `src/` 子目录结构，不计入层深），依赖只能自上而下：

```text
src/
  index.ts        对外唯一出口（exports / files 契约；只做具名转发，不承载逻辑）
  shared/         最底层：type-guards（错误提取/收窄）· boot-log · data-root
                  · package（包根定位 + 版本元数据）
  contract/       跨进程契约：ipc-schema（zod 单一来源）· native-noise（原生噪音行判定）
                  · constants（PROTOCOL_KEYS / QR_LINE_PREFIX）
  lifecycle/      进程治理：instance-lock · pid-cmdline · shutdown（停止哨兵 + 关停钩子）
  artifacts/      产物链：install-probe（装在哪）→ manifests/releases（清单形状）
                  → releases（清单读取/查询）→ download（https + sha256）
                  → seven-zip（7z 定位/执行）→ extract（解包/提取）→ locate（多级来源管线）
    manifests/    零 TS 源码相对 import（供 node 直跑的 tooling/releases 脚本引用）
  boot/           宿主装配：env-keys（键表 + 读写原语）→ launch-env（白名单策略）
                  → linux-native / win-node（平台 node 与 stub 解析）→ launcher
  host/           宿主进程内运行时（CJS bundle 入口 host/self-host.ts）
    runtime/      子进程共享基础：env · errors · state · load-config · log-config
                  · module-loader / module-guards · protocol-types / service-types / types（纯类型）
    bootstrap/    引导与观测：bootstrap · core · probe · smoke · media-patch-status
    auth/         登录与会话状态机：login · relogin · session
    protocols/    协议与服务装配：protocols · kernel-services · msg-log · assemble-ob11 · optional
    ipc/          IPC 进程边界：actions · at-resolver · attach · codec · diagnostics
                  · json-safe · ob11-bridge · sender · server（不设 barrel）
```

分层红线（0 循环依赖，文件级与目录级同时成立）：

- `shared/` 0 内部依赖；`contract/` 只允许内部互引（`native-noise.ts → ipc-schema.ts`）。
- `lifecycle/`、`artifacts/` 只依赖 `shared/`；`boot/` 只依赖 `artifacts/`、`contract/`、`shared/`；
  三者都不得反向依赖 `host/`。
- `host/` 内部严格单向：`runtime ← ipc ← auth ← bootstrap ← self-host`，且
  `runtime ← protocols ← bootstrap`；`ipc/` 不依赖 `protocols/`、`auth/`、`bootstrap/`，
  `protocols/` 不依赖 `auth/`、`bootstrap/`、`ipc/`。
- `runtime/types.ts` / `runtime/protocol-types.ts` / `runtime/service-types.ts` 保持纯类型
  （0 运行时导出）；纯类型层不新增统一的 `types.ts` 桶。
- `host/ipc/` 不设 barrel：内部引用直引具体文件，避免公共面与实现漂移。

### QQ 文件来源与管线

```text
L0 NAPUKETTO_QQ_FILES：显式文件根（含 versions/ 结构）
L1 本机安装：NAPUKETTO_QQ_PATH → Linux NAPUKETTO_QQ_DIR > /opt/QQ → 注册表 / 常见路径
L2 <数据根>/qq-files/<版本>/：下载解包产物，扫描最新可用版本
L0–L2 全失败 → 自动下载解包；autoDownload=false 时直接报错
```

- 版本选择：`latestRelease` 先按 `platform`/`arch` 过滤再取末条；`version` 既是缓存目录名
  也是 `app_version`，Linux 另记 `coreVersion`（清单 schema 2，`releases.json` 为纯文本）。
- 下载：Node 内置 `https` + `crypto`，流式 sha256、302 最多 5 跳、60s 无数据超时。
  收到 HTTP 200 才打开目标文件，流关闭后检查文件大小与摘要。`NAPUKETTO_QQ_URL` 覆盖清单
  URL，QQ 安装包临时文件带 pid + 时间戳保证并发隔离。
- URL 归一化：`normalizeDownloadUrl` 在唯一出站口把路径段 `/QQNTV2/` 降为 `/qqntv2/`
  （CDN 边缘对该段大小写敏感，大写必 403）；清单仍存官方原样 URL。
- Windows 解包：官方 exe 是 NSIS，必须完整版 `7z`（`7za` 不支持）；产物在 `Files/`，
  只提 `resources/app` 顶层 `*.node` + `*.dll`。
- Linux 解包：官方 deb 三层（deb → data.tar.xz → data.tar）；白名单 `*.node` / `*.so` /
  `*.so.N` + `pub.key` / `cacert.pem` / `package.json` / `application.json`，`sharp-lib/`
  整体保留；跳过 `avsdk/`、`resource/`、`application.asar`。
- 缓存布局固定为 Windows 同构的 `<版本>/versions/<版本>/resources/app/`，kernel 的
  wrapper 路径解析（ADR-018）无需平台分支。
- 7-Zip 选择：调用方显式指定的解包工具优先。Windows 探测按 `NAPUKETTO_7Z_PATH`、内置资产、
  系统 PATH 顺序。Linux x64 自动下载 QQ 时优先用内置 `7zz`，缺失时复用通过 SHA-256
  校验的数据根缓存 `runtime/7zip/7zz`，否则重新下载。Linux 非 x64 使用系统 PATH
  （`7zz` → `7z`），缺失时抛安装指引。
- [内置资产清单](../assets/7zip/manifest.json)记录官方发行版本、归档 URL、归档与文件的
  SHA-256。许可证按仓库规则保存为 LF，清单记录入库后的字节摘要。测试校验所有资产及
  许可证。loader 和 QQ 版本清单更新脚本使用内置工具前校验可执行文件及 Windows 的
  `7z.dll`，缺失的 DLL 或不匹配的摘要会阻止执行该工具。
- Linux x64 兜底下载使用清单中的官方归档 SHA-256。`NAPUKETTO_7Z_URL` 仅覆盖 HTTPS
  下载位置，镜像必须提供逐字节相同的归档。无效地址、非 HTTPS 地址或重定向、下载失败
  及摘要不匹配均终止兜底。归档通过校验后才在独立临时目录提取 `7zz`，校验可执行文件
  后原子更新缓存，下载或解包失败会清理临时目录。并发写入冲突时仅复用摘要匹配的成品，
  不匹配的旧缓存只在成功取得可信文件后替换。

### 平台分支

Windows：

- stub 校验：`native/prebuilt/win32-x64/QQNT.dll`（`--stub-dir` 或 `NAPUKETTO_STUB_DIR`
  覆盖），缺失在 spawn 前抛错。
- 环境：PATH 前置 stub 目录 + `wrapper.node` 目录（按 Windows 大小写不敏感的键名
  规范化，只保留一个 `PATH`），并注入 `NAPUKETTO_STUB_DIR`。其余父进程变量按环境契约白名单
  透传。
- 入站图片自动下载补丁（issue #105）：stub 私有组件在 wrapper 加载后
  运行期放行 QQ 原生收图管线（零磁盘篡改；版本特征失配自动降级，绝不盲写内存）。
  主 vtable 与对象形态均按 MSVC RTTI 运行期动态解析，9.9.33 / 9.9.37 的布局差异
  由解析层吸收（不再硬编码槽位偏移）。
  `LaunchOptions.nativeMediaPatch`（缺省 true）控制；状态 JSON 落
  `<账号数据目录>/media-patch-status.json`，self-host bootstrap 完成后读一次记日志
  （pending 时 45s 复读一次）。机制细节只在私有 `native/` 子模块。
- 宿主 node：`process.execPath` 是 node 直接用；非 Node 宿主（Bun/koishi CE）按
  `NAPUKETTO_WIN_NODE_PATH` > 系统 `where node` > `ensureWinNode` 下载缓存解析真 `node.exe`
  ——bun.exe 进程内没有该模块，`LoadLibrary` 报 1114。

Linux：

- stub：`native/prebuilt/linux-x64/libnapuketto_stub.so`（`NAPUKETTO_LINUX_STUB` 覆盖），
  预加载 `LD_PRELOAD=<stub>:<libgnutls.so.30>`；`LD_PRELOAD` 由本模块独占写入，父进程的
  `LD_PRELOAD` / `LD_LIBRARY_PATH` / `LD_AUDIT` 不会进入子进程。gnutls 是 `libbugly` 的
  无 `DT_NEEDED` 隐藏依赖。
- 宿主 node：`process.execPath` 是 node 直接用，否则 `which node`。
- HOME/XDG 收敛：`<数据根>/home`（`NAPUKETTO_LINUX_HOME` 覆盖；无数据根退到
  `<账号目录>/home`），`XDG_CONFIG_HOME` / `XDG_DATA_HOME` / `XDG_CACHE_HOME` /
  `XDG_STATE_HOME` 指到其下；`XDG_RUNTIME_DIR` 不接管（会话级目录）。
- spawn 前预检 stub / gnutls / node，缺失抛可读错误；child `error` 监听兜住异步
  ENOENT，不让宿主进程崩溃。
- Linux 恒走原生分支（ADR-027）：不再有任何宿主开关环境变量。

### launchSelfHost 环境变量契约

自建宿主不再展开父进程 `process.env`。`boot/launch-env.ts` 是唯一构造入口，按下述顺序
合并（后者覆盖前者，删除语义同样显式）：

1. **平台基础白名单**：`PATH` / `TEMP` / `TMP` / `TMPDIR` / `HOME` / `USERPROFILE` /
   `LANG` / `LC_*` / `TZ`，Windows 另含 `SystemRoot` / `WINDIR` / `COMSPEC` / `PATHEXT` /
   `APPDATA` / `LOCALAPPDATA` / `PROGRAMFILES*` / `USERDOMAIN` 等系统解析所需值；Linux 另含
   `XDG_RUNTIME_DIR` / `USER` / `LOGNAME` / `SHELL`。不继承 `NODE_OPTIONS`、`LD_PRELOAD`、
   `LD_LIBRARY_PATH`、`LD_AUDIT` 等加载器注入面。
2. **显式透传**：代理（`HTTP(S)_PROXY` / `NO_PROXY` / `ALL_PROXY` 及小写拼写、
   `NODE_USE_ENV_PROXY`）、证书（`NODE_EXTRA_CA_CERTS` / `SSL_CERT_FILE` /
   `SSL_CERT_DIR`）、配置（`NAPUKETTO_CONFIG_JSON` / `NAPUKETTO_CONFIG` / `NAPUKETTO_DATA` /
   `NAPUKETTO_SANDBOX_ROOT`）、子进程日志覆盖（`NAPUKETTO_LOG_LEVEL` /
   `NAPUKETTO_LOG_FORMAT` / `NAPUKETTO_NO_BANNER` / `NAPUKETTO_LOG_COLORIZE`）与
   用户控制标记（`NAPUKETTO_QUICK_UIN` / `NAPUKETTO_QR_ONLY` / `NAPUKETTO_SMOKE` /
   `NAPUKETTO_SMOKE_PEER` / `NAPUKETTO_PROBE` / `NAPUKETTO_LISTENER_RECORD` /
   `NAPUKETTO_DIAG`）。
3. **调用方 `extraEnv`**：显式逃生口，按原样合并；调用方不应把凭据放进来。
4. **强类型 `LaunchOptions` 字段**：`quickUin` / `qrOnly` / `ipc` / `selfHost` /
   `diagnostics` / `nativeMediaPatch` / `log` 最终生效，`false` 会删除对应继承标记。

| 变量 | 必填 | 含义 |
|---|---|---|
| `NAPUKETTO_WRAPPER_PATH` | 是 | `wrapper.node` 绝对路径（dlopen 目标） |
| `NAPUKETTO_KERNEL_ENTRY` | 是 | kernel 入口 `.mjs`，运行期动态 import |
| `NAPUKETTO_CFG_DIR` | 是 | 账号数据目录（实例锁 / boot 日志 / 配置兜底） |
| `NAPUKETTO_QQ_PATH` | 是 | QQ 入口路径（cached 来源为语义占位） |
| `NAPUKETTO_QQ_VERSION` | 是 | 版本目录名，即 `app_version` |
| `NAPUKETTO_SELF_HOST` | 否 | `1` = 自建宿主分支 |
| `NAPUKETTO_STUB_DIR` | 否 | stub 目录（诊断与 PATH 装配） |
| `NAPUKETTO_ADAPTER_ENTRY` | 否 | adapter 入口 `.mjs`（协议装配） |
| `NAPUKETTO_NETWORK_ENTRY` | 否 | network 入口 `.mjs`（协议装配） |
| `NAPUKETTO_CONFIG` | 否 | 全局配置路径（`napuketto.toml`） |
| `NAPUKETTO_QUICK_UIN` | 否 | 强制快速登录账号（cli `-q`） |
| `NAPUKETTO_QR_ONLY` | 否 | `1` = 跳过快速登录强制扫码（一次性：子进程读取后删除） |
| `NAPUKETTO_IPC` | 否 | `1` = IPC 子进程模式 |
| `NAPUKETTO_DIAG` | 否 | `1` = 显式启用 IPC 诊断动作（默认关闭，仅本地调试） |
| `NAPUKETTO_DATA_ROOT` | 否 | 数据根（停止哨兵；调用方 `extraEnv` 注入） |
| `NAPUTO_DISABLE_MEDIA_PATCH` | 否 | `1` = stub 跳过入站图片自动下载补丁（killswitch；`nativeMediaPatch: false` 注入，issue #105） |
| `NAPUTO_MEDIA_PATCH_STATUS` | 否 | 补丁状态文件路径（恒注入 `<账号数据目录>/media-patch-status.json`；stub 写 JSON，self-host 读后记日志） |

- 前缀唯一：只读 / 只透传规范前缀 `NAPUKETTO_*`，不做任何旧拼写别名翻译；2026-11 前缀
  统一前的历史拼写既不会被读取，也不会进入子进程。唯一例外是闭源 stub 硬编码的两个
  原生契约键（见下表，禁止改名）。
- `NAPUKETTO_QR_ONLY` 只对本次登录生效：`bootstrap-core` 读取后从 `process.env` 删除该键，
  软重登与后续重试不再被残留标记强制扫码。
- 子进程日志配置是可选公开契约：调用方可用 `LaunchOptions.log`（level / format /
  noBanner / colorize）表达，或经上述 `NAPUKETTO_LOG_*` 环境变量透传；两条路径都不会把
  环境变量值写入日志，只记录阶段与路径。
- 子进程 `cwd` 缺省由调用方指向数据根：QQ 原生层在账号上下文就绪前会 fallback 到进程
  cwd 落盘。
- `stdio` 缺省 `inherit`；cli 接管 pipe 后逐行过滤 wrapper 原生噪音。
- `onStage` 回调覆盖 stub 校验 / node 解析 / 下载 / 解包 / 提取 / spawn 各阶段提示，不打印
  环境变量值。

Bugly（QQ 内置崩溃上报）是否外传环境或崩溃材料目前只是报告主张，本仓未验证，也不以环境
收窄宣称已阻断外传；收窄仅减少子进程可见的父进程环境面。

### 外部调试沙箱

调试入口通过 `NAPUKETTO_SANDBOX_ROOT` 启用写入边界。自建宿主继承沙箱内的
临时目录和用户数据目录，工作目录仍由 CLI 设为沙箱数据根。文件日志通过
kernel 日志设施检查路径，自定义协议缓存通过同一边界检查后装配。

自建宿主动态导入 kernel 后使用 `dlopenWrapper` 和 `activateO3MiscService` 完成
原生加载与事件分发激活。这两个原语自 kernel 0.12.3 起提供，当前装配依赖以仓库锁定版本为准。

### 实例锁与进程治理

- 以账号目录为粒度。 `instance.lock` 保留旧字段，新增随机所有权标记；临时记录写完整后
  原子发布。同目录短时变更目录串行化检查、回收、发布和释放，变更目录先装入唯一标记再发布。
  清理残留变更目录时只删除观察到的标记，只移除空目录。
- PID 死亡或已确认命令行不同可回收；存活但命令行无法查询时保留占用。无锁、空或损坏
  记录可以重建。锁内 `pid` 与运行时状态文件中的 `pid` / `selfHostPid` 统一按
  `isValidPid` 校验（安全整数、`1..0x7fffffff`）：类型/范围非法直接拒绝，既不用于
  `process.kill` 探活，也不拼进 PowerShell / `/proc` 查询，避免把任意值当进程号；
  合法 PID 的 signal 0 存活探测保持不变（`EPERM` 仍视为存活）。
  释放必须匹配本进程取得的所有权标记。退出时释放，强杀后下次启动回收。
  升级同一账号目录的宿主时先停止旧宿主，旧代码写锁没有参与变更互斥。
- 信号、全局与单账号停止哨兵、IPC stop/restart、父进程断开 stdin/stdout、OB11
  进程控制和引导失败都进入同一关停。首次触发决定退出码，后续请求共享完成结果。
  先停止接收 IPC 和心跳、取消探测，再停止协议和 IPC 转发，最后释放桥、缓存和监听器。
  每个异步清理钩子最多等待 1.5 秒，整个关停最多 7 秒。超时后尝试后续清理，到总时限强制退出。
  同步阻塞的原生调用仍由父进程超时强杀。
  退出前尽量冲刷 stdout，进程退出钩子最后释放账号锁。请求式退出为 0，保留引导错误码 1/78。
- 停止哨兵仍使用 `<数据根>/napuketto.stop` 或 `<数据根>/napuketto.stop.<uin>`。
  只识别进程启动后写入的请求，全局内容可指定 `all`、uin 或留空。

### IPC 模式与 OB11 容器

- `NAPUKETTO_IPC=1`：stdout 专用于 JSON 行协议 `{v, type, id?, payload}`（v=1），stdin 收
  action / control / ping；kernel console 日志关闭，避免撕裂协议行。
- 消息类型：status（booting/dlopening/logging/sessioning/ready/failed）、login、qr、
  event、result、log、ping/pong、action、control（stop/restart/login/status）。
- 宿主启动即读 stdin。物理行上限 16 MiB（UTF-8 原始字节，含可选 CR，不含 LF）。
  超长行丢弃至下一 LF，日志不含原文。不调度 EOF 时未结束的尾帧。最多 256 个在途动作，
  无等待队列；超限以原请求 ID 返回 `IPC_BUSY`。ping 和 control 不占用动作名额。
- 登录前可调用 `login.getSelf`（身份未知时返回 `INVALID_STATE`）；core 创建后开放
  `login.refreshQr`。登录后 `attachIpcServices` 把
  kernel 点分动作并入同一张表，Msg/Group/Buddy/RecentContact/Login 五条通道转 event。
- `msg.addReaction` 是稳定业务动作，参数为 `{ chatType?, peerUid? / peerUin?, msgId, emojiId }`。
  私聊（默认 `chatType: 1`）和临时会话（`100`）可传 UID，或传 QQ 号转换为 UID；
  群聊（`2`）的 `peerUid` 或 `peerUin` 填群号。两者都提供时优先 `peerUid`。
  `msgId` 为消息事件、发送或历史返回的原生字符串，`emojiId` 为 QQ 系统表情索引的十进制
  字符串（如 `"105"`），使用 QQ 表情类型 `"1"`。每次委托 kernel 按会话精确查找并添加
  表态，独立于 OB11 映射。成功返回 `{ ok: true }`，失败返回带 `code` 和 `message` 的
  IPC 错误（包括 `INVALID_PARAM`、`NOT_FOUND`、`INVALID_STATE` 及平台权限错误）。调用
  需要支持 `MsgApi.setMsgEmojiLikeById` 的 kernel，旧 kernel 下该动作返回 `INVALID_STATE`。
- **诊断动作默认关闭**：`diag.*`（6 个反射调用 + `diag.richMediaTmpPaths` 枚举）只在
  `NAPUKETTO_DIAG=1`（或 `LaunchOptions.diagnostics: true`）时注册；常规动作表不含诊断名，
  调用方得到 `NOT_FOUND`，不会误触原生反射面。显式启用后仍按目标限定的方法 allowlist 执行：
  `__methods` 只返回有长度上限的方法名，`args` 数量有上限，未知/危险方法直接拒绝；枚举动作
  只读，不再触发 `setFlashTransferDir` 等副作用。需要更激进的实验时使用 kernel 自己的探测
  原语，不扩大 IPC 反射面。诊断启停不改变业务动作表。
- 初次引导与软重登都先完成动作挂载，再写出 `status(ready)`，随后才允许写出
  `event`（含 OB11）。装配期间到达 IPC 出口的事件直接丢弃。软重登在清理旧装配前
  发 `status(sessioning)`，暂停事件转发。如果写入 ready 同步失败，成功重播后才放行。
- 心跳 15s。stdout 关闭、写失败或发送队列超过 32 MiB 时关停。
- `status(ready)` 可携带 `selfInfo: {uin, uid, nick}`，来自同一次装配采用的登录结果。`control status` 重播完整快照。 `login.getSelf` 从同一快照返回
  `{uin, uid, nickname}`，只在该代服务 ready 且身份完整时成功。旧版解析器兼容 IPC v1
  并可能丢弃新增字段，消费方更新 schema 后才能原子读取 ready 与身份。
- 单独的 `login` 帧供登录 UI 使用。初次竞速的迟到进度/成功结果不会改写身份。
  软重登等待登录结果期间保留当前服务快照；采纳新结果并发出 sessioning 后身份未知，
  新一代 ready 才发布新身份。早期、失败或缺 uin/uid 时保持未知。跨代或跨子进程收到的
  异步查询结果由驱动按当前连接与状态校验，不能拿配置账号填补。
- Node 宿主诊断走 stderr 或安全日志。真实 QQ 可绕过 JS 直接写 fd 1，仍需下游过滤
  原生日志及执行状态恢复；该平台边界需要真实 QQ 环境复验。
- 编码统一 `encodeIpcMessage`：先 `toJsonSafe`（Map→对象、Set→数组、环引用丢分支）再
  stringify，否则 Map/Set 跨进程即丢。
- OB11 容器可选：IPC 模式且 `NAPUKETTO_ADAPTER_ENTRY` + `NAPUKETTO_NETWORK_ENTRY` 已注入时，
  `attachOb11IpcBridge` 动态 import adapter 子路径；按实际登录账号从主配置提取
  `onebot11.media`，交给动态载入的 OB11 schema，默认 `public-only`。仅将媒体配置
  注入内存 seed，其他字段取协议缺省值。`subscribeOnly()` 只订阅不启传输，动作名平铺进共享表（OB11
  snake_case 与 kernel 点分命名不冲突），事件经 `sendEvent("ob11", post_type, [event])`
  透出。装配会等待 `subscribeOnly()` 完成（含媒体缓存首次清理），引导日志记录等待
  起点。装配失败时撤销 OB11 订阅和已挂载动作，降级为纯 kernel 动作面。注入的
  adapter 必须支持媒体出站和本地目录配置，避免老版本动作桥忽略策略。

OB11 IPC 桥和网络适配器共用账号协议段的 `media.localMediaRoots`，IPC 无配置时亦拒绝调用方本地路径。
桥会通过 schema 确认注入的 adapter 识别本地策略，再挂载动作。相对根目录以主配置文件所在目录为基准，
内联配置以宿主数据目录为基准。QQ 富媒体目录在 OB11 和 Satori 装配时单独注入，用于经当前账号查询得到的资源。

### IPC 群请求与好友身份

- `Group/onRequest` 的唯一参数是 `IpcGroupRequestSchema` 定义的对象，包含登录账号、请求引用、
  发起人 UID 及可解析的 UIN。邀请账号本人、受管理员审批的邀请入群与主动申请各有独立 kind。
- `group.respondToRequest` 接收原样回传的请求引用、明确的 `approve` 和可选理由。动作绑定
  当前登录账号并保留原队列，由 kernel 语义 API 完成审批。既有事件转发和 IPC v1 帧兼容。
- `friend.getFriendList` 返回 `IpcFriendSchema[]`。每项提供 UID、可空 UIN、昵称和备注。
  下游只有在 UIN 非空时才能将其作为 QQ 号使用。

合成邀请事件及审批请求示例（每行一帧）：

```jsonl
{"v":1,"type":"event","payload":{"service":"Group","name":"onRequest","args":[{"selfUin":"10001","request":{"seq":"9007199254740993","groupCode":"808","kind":"invitation","doubt":true},"initiatorUid":"u_inviter","initiatorUin":"90001"}]}}
{"v":1,"type":"action","id":42,"payload":{"action":"group.respondToRequest","params":{"selfUin":"10001","request":{"seq":"9007199254740993","groupCode":"808","kind":"invitation","doubt":true},"approve":true}}}
{"v":1,"type":"result","id":42,"payload":{"ok":true}}
```

`initiatorUin` 只在 UID 转换成功且所得号码有效时出现。`invitation` 的受邀者是当前
登录账号，另两种请求记录的 `targetUid` 以原生通知提供的值为准。跨账号引用或参数
校验失败返回 `INVALID_PARAM`，旧 kernel 缺少语义 API 时返回 `INVALID_STATE`。

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

- login-race 的抢占结果经 `preemptRef` 接管初始竞速，由初次装配发布 `login(logged_in)`。
  ready 态重装配完成后发布 `status(ready, selfInfo)` 与 `login(logged_in, 新 selfInfo)`。
- 互斥 claim/release：在途登录或重装配期间的新指令直接忽略。
- 清理顺序：OB11 桥 stop（含动作表条目移除）→ `attachIpcServices` stop →
  `services.dispose()`（桥 / 缓存 / 消息日志退订，幂等）。
- 重装配失败：sendStatus(failed) 后走统一关停并退出 1，交宿主重启循环回收。

### 协议装配：一协议一广播器

- OB11 / Satori / Milky 各自 `new EventBroadcaster()`，只传给对应 adapter 的
  `broadcaster` 选项；Kurobot 是出向纯客户端协议，无广播器。
- 协议段提取与 adapter 子路径校验由协议描述表驱动（`PROTOCOL_KEYS` +
  `importSubpathModule`），不再逐协议手写分支。
- 可选协议「账号段非空才装配」：satori 段空返回 `null`，kurobot / milky 同范式；
  且段为空时不 `import` 对应 adapter 子路径（未启用协议零加载，兑现 ADR-014）。
- IPC 桥的广播器在进程边界上独立，与 CLI 协议装配互不影响。

### 协议构造入参契约（编译期守卫）

- `runtime/protocol-types.ts` 的构造入参**不是** `Record<string, unknown>`：每个协议的
  `*AdapterOptionsLike` 逐字段描述 loader 实际传入的装配面（字段名 = adapter 公开选项名，
  值类型 = loader 侧最小结构面 / `unknown`）。`Record<string, unknown>` 会把字段名契约
  整体推迟到运行期（adapter 重命名一个可选构造项，`tsc` 全绿，直到真正启用该协议才炸）。
- 字段名漂移由 [`../tests/host/runtime/protocol-types.test-d.ts`](../tests/host/runtime/protocol-types.test-d.ts)
  守卫，随根 `pnpm check`（`tsc --noEmit`）执行，四向断言：模块导出键 ⊆ adapter 实际导出、
  loader 入参键 ⊆ adapter 选项键、adapter 必填项 ⊆ loader 入参必填项（含「loader 降级成
  可选」）、原始值字段类型兼容。该测试取 adapter **源码**类型（非 `dist`），改字段名当场红，
  不依赖构建顺序。
- 为什么不直接 `import type` adapter 的真实选项类型：kernel 的 `MsgApi` / `ConfigBase`
  等带 `private` 成员，`private` 按声明来源比较，loader 的最小结构镜像**永远不可能**
  赋值给它们；直连会把「最小面」逼成「完整实现镜像」，把启动层焊死在 kernel 类型上。
  所以契约放在 loader 侧手写、由类型测试对拍，仍保持编译期 0 workspace 依赖。

### 内联配置与退出码

- 来源优先级：`NAPUKETTO_CONFIG_JSON` > `NAPUKETTO_CONFIG` > `<账号目录>/napuketto.toml`。
- 内联生效时零 toml 读写，`cfgFile` 返回哨兵 `"<inline>"`；坏内联回退文件形态并记日志
  （cli 主路径已在拉起前校验）。
- 协议段 seed 的 zod 失败包装为 `ConfigError`（按错误名复刻 kernel 契约，不静态依赖
  kernel），沿 `startProtocols` → `bootstrap` 重抛，self-host 以 78（EX_CONFIG）退出。
- 其余引导失败 exit 1；请求式关停 exit 0。宿主用 78 区分「配置未就绪」与运行时崩溃。

## 跨包契约

- 编译期只依赖 zod；kernel / adapter / network 一律运行期 `import(file://…)`，接口面在
  `../src/host/runtime/types.ts`（kernel 契约）、`../src/host/runtime/protocol-types.ts`（动态模块导出面）与各模块内
  声明最小面，不新增 workspace 依赖（依赖方向红线）。构造入参的字段名漂移由 **测试目录**的
  类型对拍守卫（`tests/host/runtime/protocol-types.test-d.ts`，取 adapter/network 源码类型，
  不进入包依赖图，见「协议构造入参契约」）。
- `NAPUKETTO_KERNEL_ENTRY` 指向 kernel 构建产物；loader 只用其语义化能力
  （`NapukettoCore` / `startNapuketto`、`resolveAppidQua`、`quickLogin`、
  `initAndStartSession`、`resolveQqUserDataRoot` / `resolveQqGlobalPath`、`PathWrapper`
  等），能力探测失败即判引导失败，不在本层实现业务。
- 错误传播：`ConfigError` → 78；其余异常在 bootstrap 链收敛为 `false` → self-host
  exit 1，原因写 `<账号目录>/napuketto-boot.log`；IPC 模式另发 failed（`NOT_LOGIN` /
  `INVALID_STATE` / `INVALID_PARAM` / `UNKNOWN`）。致命失败（bootstrap / 协议装配 /
  self-host 退出前）同时经 `logFatal` 写 `stderr`（含 boot 日志路径，issue #144），
  让 Docker/终端能看到退出原因；**不写 stdout**——IPC 模式 stdout 专用于 JSON 协议行。
- 公共出口 [`../src/index.ts`](../src/index.ts)：`launchSelfHost`、`resolveQqFiles`、
  `ensureQqFiles`、解包与清单原语、实例锁、关停、IPC schema（zod 单一来源，koishi
  插件 import 同一份）。
- 进程拓扑：`apps/cli` 或 koishi 插件 → `launchSelfHost` → 每账号一个 self-host；
  Docker 部署形态见 [`docker.md`](../../../docs/guides/docker.md)。

## 关键取舍与不变量

1. **不内置腾讯二进制**：npm 包、镜像、仓库都不得含 `wrapper.node`、`QQNT.dll`、官方
   安装包（含压缩/编码形态）；只放自研 stub 与纯文本 `releases.json`。
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
