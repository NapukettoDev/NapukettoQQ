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
  ├─ 动态 import kernel → dlopenWrapper → activateO3MiscService
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
- 下载：Node 内置 `https` + `crypto`，流式 sha256、302 最多 5 跳、60s 无数据超时。
  收到 HTTP 200 才打开目标文件，流关闭后检查文件大小与摘要。`NAPUTO_QQ_URL` 覆盖清单
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
- 7-Zip 选择：调用方显式指定的解包工具优先。Windows 探测按 `NAPUTO_7Z_PATH`、内置资产、
  系统 PATH 顺序。Linux x64 自动下载 QQ 时优先用内置 `7zz`，缺失时复用通过 SHA-256
  校验的数据根缓存 `runtime/7zip/7zz`，否则重新下载。Linux 非 x64 使用系统 PATH
  （`7zz` → `7z`），缺失时抛安装指引。
- [内置资产清单](../assets/7zip/manifest.json)记录官方发行版本、归档 URL、归档与文件的
  SHA-256。许可证按仓库规则保存为 LF，清单记录入库后的字节摘要。测试校验所有资产及
  许可证。loader 和 QQ 版本清单更新脚本使用内置工具前校验可执行文件及 Windows 的
  `7z.dll`，缺失的 DLL 或不匹配的摘要会阻止执行该工具。
- Linux x64 兜底下载使用清单中的官方归档 SHA-256。`NAPUTO_7Z_URL` 仅覆盖 HTTPS
  下载位置，镜像必须提供逐字节相同的归档。无效地址、非 HTTPS 地址或重定向、下载失败
  及摘要不匹配均终止兜底。归档通过校验后才在独立临时目录提取 `7zz`，校验可执行文件
  后原子更新缓存，下载或解包失败会清理临时目录。并发写入冲突时仅复用摘要匹配的成品，
  不匹配的旧缓存只在成功取得可信文件后替换。

### 平台分支

Windows：

- stub 校验：`native/prebuilt/win32-x64/QQNT.dll`（`--stub-dir` 或 `NAPUTO_STUB_DIR`
  覆盖），缺失在 spawn 前抛错。
- 环境：PATH 前置 stub 目录 + `wrapper.node` 目录，并注入 `NAPUTO_STUB_DIR`。
- 入站图片自动下载补丁（issue #105）：stub 私有组件在 wrapper 加载后
  运行期放行 QQ 原生收图管线（零磁盘篡改；版本特征失配自动降级，绝不盲写内存）。
  `LaunchOptions.nativeMediaPatch`（缺省 true）控制；状态 JSON 落
  `<账号数据目录>/media-patch-status.json`，self-host bootstrap 完成后读一次记日志
  （pending 时 45s 复读一次）。机制细节只在私有 `native/` 子模块。
- 宿主 node：`process.execPath` 是 node 直接用；非 Node 宿主（Bun/koishi CE）按
  `NAPUTO_WIN_NODE_PATH` > 系统 `where node` > `ensureWinNode` 下载缓存解析真 `node.exe`
  ——bun.exe 进程内没有该模块，`LoadLibrary` 报 1114。

Linux：

- stub：`native/prebuilt/linux-x64/libnapuketto_stub.so`（`NAPUTO_LINUX_STUB` 覆盖），
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
| `NAPUTO_DISABLE_MEDIA_PATCH` | 否 | `1` = stub 跳过入站图片自动下载补丁（killswitch；`nativeMediaPatch: false` 注入，issue #105） |
| `NAPUTO_MEDIA_PATCH_STATUS` | 否 | 补丁状态文件路径（恒注入 `<账号数据目录>/media-patch-status.json`；stub 写 JSON，self-host 读后记日志） |

- 子进程 `cwd` 缺省由调用方指向数据根：QQ 原生层在账号上下文就绪前会 fallback 到进程
  cwd 落盘。
- `stdio` 缺省 `inherit`；cli 接管 pipe 后逐行过滤 wrapper 原生噪音。
- `onStage` 回调覆盖 stub 校验 / node 解析 / 下载 / 解包 / 提取 / spawn 各阶段提示。

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
  记录可以重建。释放必须匹配本进程取得的所有权标记。退出时释放，强杀后下次启动回收。
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

- `NAPUTO_IPC=1`：stdout 专用于 JSON 行协议 `{v, type, id?, payload}`（v=1），stdin 收
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
- OB11 容器可选：IPC 模式且 `NAPUTO_ADAPTER_ENTRY` + `NAPUTO_NETWORK_ENTRY` 已注入时，
  `attachOb11IpcBridge` 动态 import adapter 子路径；按实际登录账号从主配置提取
  `onebot11.media`，交给动态载入的 OB11 schema，默认 `public-only`。仅将媒体配置
  注入内存 seed，其他字段取协议缺省值。`subscribeOnly()` 只订阅不启传输，动作名平铺进共享表（OB11
  snake_case 与 kernel 点分命名不冲突），事件经 `sendEvent("ob11", post_type, [event])`
  透出。装配会等待 `subscribeOnly()` 完成（含媒体缓存首次清理），引导日志记录等待
  起点。装配失败时撤销 OB11 订阅和已挂载动作，降级为纯 kernel 动作面。注入的
  adapter 必须支持 `media.outboundPolicy`，以免老版本动作桥忽略媒体策略。

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
