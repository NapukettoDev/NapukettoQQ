# 配置与路径

## 1. 配置文件

所有配置在**项目根**的单个 TOML 文件：

```
<项目根>/napuketto.toml
```

- 首次启动或 `napuketto config init` 时生成带注释模板；已存在则不覆盖。
- 本机配置不入库（`.gitignore`），模板由 cli/scaffold 生成。
- 不再使用独立 JSON 协议配置文件；`ConfigBase` 仍支持按扩展名读取 JSON，但主配置固定 TOML。

配置来源优先级（文件形态下仍为单一 TOML；全链路 cli / loader 一致，2026-10-25）：

1. `NAPKETTO_CONFIG_JSON` 环境变量：内联配置 JSON 文本（见 1.1；最高优先级）。
2. `NAPKETTO_CONFIG` 环境变量（显式完整路径）。
3. 项目根探测：入口模块向上找 `pnpm-workspace.yaml`；找不到则从 `cwd` 向上找
   `pnpm-workspace.yaml` 或 `package.json`。
4. 数据根兜底：`<dataRoot>/napuketto.toml`。

CLI 启动时会把解析结果通过 `NAPKETTO_CONFIG` 注入自建宿主，保证子进程读到同一份配置
（内联形态改为经环境变量整树继承，不注入文件路径）。

### 1.1 内联配置 `NAPKETTO_CONFIG_JSON`（嵌入式宿主，2026-10-25）

KuroBridge 等嵌入式宿主每次拉起前整体生成配置，经环境变量喂 JSON 文本（与
napuketto.toml **同构**：`dataDir` / `autoRestart` / `restartDelayMs` / `accounts[]` /
`log`，协议段嵌在账号内），消除托管 toml 文件本体。

- 内联生效时不读、不写、不校验任何 toml 文件：跳过模板生成、跳过 `NAPKETTO_CONFIG`
  路径注入；启动日志打一行 `配置来源: inline（NAPKETTO_CONFIG_JSON）`。
- 校验失败与文件形态同族（ConfigError，见退出码契约），错误文案指明「内联配置」
  且不含任何 toml 文件路径。
- 协议段热更新在内联形态不可用（无文件可重读；seed 模式本就不读盘）。
- Windows 单环境变量上限 32767 字符（约 32KB），嵌入式配置形状远小于该限；
  超限宿主退回 `NAPKETTO_CONFIG` 文件形态。
- 键名精确匹配（Windows 的 process.env 本身大小写不敏感）；空串 / 纯空白视为未设置。

## 2. 数据根

数据根承载账号目录、日志、缓存、QQ 原生文件与运行时状态。优先级：

1. CLI `--data-dir <dir>`。
2. `NAPKETTO_DATA` 环境变量。
3. `<项目根>/.napuketto`（默认）。
4. 裸脚本场景回退用户目录下的 `.napuketto`。

支持绝对路径、`~/` 前缀（用户主目录）和相对路径（相对启动目录）；消费端
`resolveDataRoot` 统一展开为绝对路径。**配置文件位置与数据根解耦**：默认在项目根
（`NAPKETTO_CONFIG` 可显式覆盖），`dataDir` 只决定数据放哪里。

目录布局：

```
<数据根>/
├─ <uin>/                          # 每个账号一个目录
│  ├─ config/                      # 账号级文件（历史产物；协议配置已改走 TOML seed）
│  ├─ logs/
│  │  ├─ napuketto.log             # kernel pino 文件日志
│  │  └─ loader.log                # loader 业务/校准日志
│  ├─ cache/                       # 临时文件、媒体缓存、qrcode.png
│  ├─ instance.lock                # 单实例锁
│  ├─ napuketto-boot.log           # 引导阶段纯文本日志
│  └─ runtime.json                 # status/stop/restart 读取的运行时状态
├─ supervisor.json                 # 多账号 supervisor 状态
├─ qq-files/<版本>/versions/<版本>/resources/app/   # 下载解包的 wrapper.node 与依赖
├─ tmp/                            # 下载临时文件
└─ runtime/7zip/7zz                # Linux 7-Zip 缓存（内置资产缺失时）
```

## 3. 全局字段

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `dataDir` | string | `<项目根>/.napuketto` | 数据根；支持 `~` 与相对路径 |
| `autoRestart` | boolean | `true` | supervisor 是否自动重启崩溃账号 |
| `restartDelayMs` | 正整数 | `2000` | 重启延迟（毫秒） |
| `accounts` | 数组 | 无（必填） | 至少一个账号，见下 |

`config apply` 用外部文件做**顶层合并**（`{ ...existing, ...patch }`）后整体校验写回；
`config list` 打印当前有效配置与账号目录清单。

### 3.1 日志段 `[log]`（2026-10-25 日志可配置化）

不配置该段即用缺省：控制台格式按 TTY 自动（终端 = pretty 多行彩色，与历史行为
一致；管道/重定向 = single-line 单行无色），全局级别 info，启动 banner 打印。

```toml
[log]
format = "single-line"     # pretty | single-line | json（缺省按 TTY 自动）
level = "info"             # trace|debug|info|warn|error|fatal（控制台级别）
banner = true              # 启动字符画（supervisor 派生子进程自动不再打）
timestamp = "local"        # local=[HH:MM:ss.l] | iso8601=2026-10-25T16:01:33.294+08:00 | elapsed=+123.456s
unboundReceive = true      # false = 未绑定频道的接收行不打（kurobot 握手拿到绑定表后生效）

[log.levels]               # 按模块覆盖级别，模块：cli / kernel / loader / ob11
# loader = "debug"         # 例：终端上看接收行（2026-10-25 起接收行默认降 debug）
# ob11 = "debug"           # 例：协议校准数据（含原始 hex，逆向/校准采集用）

[log.file]                 # 可选独立文件 sink（相对路径按数据根展开）
# path = "logs/napuketto-console.log"
# level = "debug"          # 文件级别可低于控制台（控制台干净与排查信息兼得）
```

- **pretty**：pino-pretty 多行彩色（终端现状）。
- **single-line**：一条记录一行，字段内联 `key=value`：
  `[16:20:41.481] INFO (cli/14344): 启动账号 service=cli qq=3567141148`。
- **json**：NDJSON，每行一个完整对象，可逐行 `JSON.parse`：
  `{"time":"...+08:00","level":"info","module":"loader","account":"3567141148","pid":27256,"msg":"..."}`
  （`module` = logger 来源 cli/kernel/loader/ob11；`account` = 登录账号，已知时才有）。
- 级别重分配（默认生效，CHANGELOG 列出）：ob11 校准遥测（含 raw hex）与
  `loader | 接收` 行降 debug；QQ 文件来源/数据目录等引导细节降 debug；
  账号上线、QR 状态、握手结果、致命错误保持 info 及以上。warn 级 raw 字段
  截断为 64 字符 + `…(+N)`，完整值在 debug 级。
- 时间戳统一取单调墙钟（`performance.timeOrigin + performance.now()`）：
  QQNT 原生层会在部分回调窗口内篡改进程 `Date`（实测 onRecvSysMsg 期间记录
  时间冻结为假值），单调钟不受影响，三层（cli/kernel/loader）同源。

## 4. 账号

```toml
[[accounts]]
qq = "10001"          # 必填，5-11 位纯数字；模板占位值 123456 / 654321 会被拒绝
enabled = true        # 可选，默认 true；supervisor 只拉起启用的账号

[accounts.onebot11]   # 段存在 = 启用 OB11；空段也合法（使用全部默认值）
[accounts.satori]     # 段存在 = 启用 Satori
[accounts.kurobot]    # 非空段才启用 KuroBot；段内必须含 url（空段等同未启用）
```

- 账号内没写某协议段 = 不启用该协议。
- 显式 `-q <uin>` 启动单账号时绕过 `accounts` 列表与 `enabled` 过滤。
- `qq` 必须与登录后的实际 uin 一致；协议段按登录 uin 从 `accounts` 中匹配。

## 5. OneBot 11 段

协议级字段：

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `token` | string | 空 | 全局鉴权 token；实例可覆盖。空 = 不鉴权（仅本机调试） |
| `heartbeatInterval` | 整数 | `3000` | 心跳 meta 事件间隔（毫秒）；`0` 关闭 |
| `reportSelfMessage` | boolean | `false` | 是否上报机器人自己发的消息 |
| `messagePostFormat` | `"array"` / `"string"` | `"array"` | 消息段数组或 CQ 码字符串 |
| `groupUploadAsNotice` | boolean | `false` | `true` = 含文件元素的群消息改报 `group_upload` notice；`false` = 作为 message 的 file 段 |
| `httpServers` | 数组 | `[]` | HTTP 反向服务器（接收第三方 POST 指令） |
| `httpPostUrls` | 数组 | `[]` | HTTP 正向上报（Webhook） |
| `wsServers` | 数组 | `[]` | WS 反向服务器（第三方客户端连入） |
| `wsReverseUrls` | 数组 | `[]` | WS 正向客户端（主动连第三方，双向） |

传输实例字段与默认值：

| 实例 | 字段 |
|---|---|
| `httpServers[]` | `enabled=false`、`host="127.0.0.1"`、`port=3000`、可选 `token` |
| `httpPostUrls[]` | `enabled=false`、`url`、可选 `token`、可选 `timeoutMs`（缺省不超时） |
| `wsServers[]` | `enabled=false`、`host="127.0.0.1"`、`port=3001`、可选 `token`、`heartbeatInterval=30000`（WS ping） |
| `wsReverseUrls[]` | `enabled=false`、`url`、可选 `token`、`reconnectDelayMs=5000`、`maxReconnectAttempts`（缺省无限）、`rejectUnauthorized=true`、`heartbeatInterval=30000` |

鉴权：实例 `token` 覆盖全局；HTTP/WS 握手接受 `Authorization: Bearer <token>`、裸
`Authorization: <token>` 或 `?access_token=<token>`。WS 鉴权失败以 4401 关闭。

旧版单对象字段（`http` / `httpPost` / `ws` / `wsReverse`）已移除；zod 会静默忽略，不做迁移。

## 6. Satori 段

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `token` | string | 空 | 全局鉴权 token；空 = 不鉴权 |
| `cacheDir` | string | `<账号目录>/cache` | 媒体资源下载缓存目录 |
| `httpServers` | 数组 | `[]` | HTTP RPC（`POST /v1/{resource}.{method}`） |
| `wsServers` | 数组 | `[]` | WS 事件服务（路径固定 `/v1/events`） |

实例字段：`enabled=false`、`host="127.0.0.1"`、`port`（HTTP 默认 5500 / WS 默认 5501）、
可选 `token`（覆盖全局）。HTTP 用 `Authorization: Bearer <token>`；WS 在 `IDENTIFY` 信令的
`body.token` 中校验。

## 7. KuroBot 段

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `url` | string | 无（必填） | KuroBridge 服务端地址，`ws://` 或 `wss://` |
| `token` | string | `""` | 鉴权 token；服务端配了非空 token 时必须一致，否则 1008 关闭 |
| `client` | string | `napukettoqq/<adapter 版本>` | hello 自报身份 |
| `commandPrefix` | string | `"/"` | 群消息以此前缀开头 → 发 command 帧 |
| `pingIntervalMs` | 正整数 | `15000` | 应用层心跳；须显著小于服务端 30s 空闲阈值 |
| `chatTemplate` | string | `"[{player}] {content}"` | MC 聊天 → QQ 群 |
| `joinTemplate` | string | `"{player} 加入了服务器"` | 玩家进服 |
| `leaveTemplate` | string | `"{player} 离开了服务器"` | 玩家退服 |
| `deathTemplate` | string | `"{player} {message}"` | 玩家死亡；`message` 为空时显示“死亡了” |

模板占位符：`{player}`、`{content}`、`{message}`；未知占位符原样保留。所有发群文本超过
1500 个 UTF-16 码元时截断并追加 `…(截断)`。

## 8. 最小示例

```toml
autoRestart = true
restartDelayMs = 2000

[[accounts]]
qq = "10001"
enabled = true

[accounts.onebot11]
token = "change-me"
heartbeatInterval = 3000
messagePostFormat = "array"

[[accounts.onebot11.httpServers]]
enabled = true
host = "127.0.0.1"
port = 3000

[[accounts.onebot11.wsServers]]
enabled = true
host = "127.0.0.1"
port = 3001

[[accounts]]
qq = "10002"

[accounts.satori]
token = "change-me-too"

[[accounts.satori.httpServers]]
enabled = true
host = "127.0.0.1"
port = 5500

[[accounts.satori.wsServers]]
enabled = true
host = "127.0.0.1"
port = 5501
```

完整带注释模板见 `apps/cli/src/config-template.ts`，或运行 `napuketto config init` 查看。

## 9. 环境变量

用户可设置的：

| 变量 | 作用 |
|---|---|
| `NAPKETTO_CONFIG_JSON` | 内联配置 JSON 文本（最高优先级，见 1.1） |
| `NAPKETTO_CONFIG` | 全局配置文件路径 |
| `NAPKETTO_DATA` | 数据根 |
| `NAPUKETTO_LOG_LEVEL` | 日志级别覆盖（全进程链生效；兼容旧拼写 `NAPKETTO_LOG_LEVEL`） |
| `NAPUKETTO_LOG_FORMAT` | 输出格式覆盖（pretty / single-line / json） |
| `NAPUKETTO_NO_BANNER` | `1`/`true` = 关启动字符画 |
| `NAPUKETTO_LOG_COLORIZE` | `1`/`0` 颜色覆盖（CLI 顶层向管道子进程传播用） |
| `NAPUTO_QQ_PATH` | 本机 QQ 安装路径（`QQ.exe`） |
| `NAPUTO_QQ_FILES` | 显式 QQ 文件根（含 `versions/` 结构） |
| `NAPUTO_QQ_URL` | 覆盖 QQ 安装包下载地址 |
| `NAPUTO_STUB_DIR` | stub `QQNT.dll` 目录 |
| `NAPUTO_7Z_PATH` / `NAPUTO_7Z_URL` | 7-Zip 可执行文件 / Linux 7zz 下载地址 |
| `NAPUTO_WINE` | Linux wine 可执行文件（默认 `wine`） |
| `NAPUTO_WIN_NODE_PATH` | wine/非 Node 宿主使用的 Windows 版 `node.exe` |
| `NAPUTO_QUICK_UIN` / `NAPUTO_QR_ONLY` | 强制快速登录账号 / 强制扫码 |
| `NAPUTO_SMOKE` / `NAPUTO_SMOKE_PEER` | 启动后收发冒烟自检 |
| `NAPUTO_PROBE` | 运行时探测（诊断用） |

`NAPUTO_KERNEL_ENTRY`、`NAPUTO_ADAPTER_ENTRY`、`NAPUTO_NETWORK_ENTRY`、`NAPUTO_CFG_DIR`、
`NAPUTO_QQ_VERSION`、`NAPUTO_WRAPPER_PATH`、`NAPUTO_SELF_HOST`、`NAPUTO_IPC` 等由 CLI/loader
注入，正常部署不要手工设置。
