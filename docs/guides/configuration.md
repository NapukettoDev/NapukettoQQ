# 配置与路径

> 本页说明 NapukettoQQ 的全局配置、数据目录与运行环境变量。
> 适用场景：首次部署、修改账号或协议端口、嵌入式宿主注入配置；前置是已安装 CLI。

## 操作步骤

1. 运行 `napuketto config init`；文件形态下首次启动也会自动生成模板，已存在不覆盖。
2. 在 `[[accounts]]` 填入真实 `qq`，并在账号内添加所需协议段。
3. 需要独立数据目录时，启动加 `--data-dir <dir>` 或设置 `NAPKETTO_DATA`。
4. 启动前运行 `napuketto config validate`；返回 0 才继续。

## 配置文件与来源

默认位置为项目根 `napuketto.toml`，与数据根解耦。来源优先级：

1. `NAPKETTO_CONFIG_JSON`：内联 JSON 文本（最高优先级，见下节）。
2. `NAPKETTO_CONFIG`：显式配置文件路径。
3. 项目根探测：入口模块向上找 `pnpm-workspace.yaml`；未命中则从 `cwd` 向上找
   `pnpm-workspace.yaml` 或 `package.json`，取根下 `napuketto.toml`。
4. 数据根兜底：`<dataRoot>/napuketto.toml`。

文件来源且缺失时自动写入带注释模板，全文见 [template.ts](../../apps/cli/src/config/template.ts)。

### 内联配置 `NAPKETTO_CONFIG_JSON`

KuroBridge 等嵌入式宿主把整份配置作为 JSON 文本经环境变量传入，契约如下：

- 与 `napuketto.toml` 同构：`dataDir` / `autoRestart` / `restartDelayMs` / `accounts[]` /
  `log`，协议段仍嵌在账号内；共用同一校验器。
- 生效时零 toml 落盘：不生成模板，不读、不写、不校验任何 toml，也不注入 `NAPKETTO_CONFIG`。
- 协议段热更新不可用：无文件可重读，装配使用启动时的配置。
- 键名精确匹配；空串或纯空白视为未设置，回退文件形态。
- Windows 单环境变量上限 32767 字符（约 32KB）；超限宿主应改用 `NAPKETTO_CONFIG` 文件形态。
- 校验失败均为 ConfigError（退出码 78），错误文案标注「内联配置」且不含 toml 路径。

## 数据根

数据根承载账号目录、日志、缓存、QQ 原生文件与运行时状态。优先级：

1. CLI `--data-dir <dir>`。
2. `NAPKETTO_DATA` 环境变量（空串视为未设置）。
3. `<项目根>/.napuketto`。
4. 裸脚本场景（探测不到项目根）：用户主目录下 `.napuketto`。

支持绝对路径、`~/` 前缀与相对启动目录的路径，消费端统一展开为绝对路径。

布局（`<数据根>/`）：

```text
<uin>/                 # 每账号：config/、logs/、cache/、instance.lock、runtime.json
                       # logs/ 内为 napuketto.log、loader.log；账号根下 napuketto-boot.log 为引导日志
supervisor.json        # 多账号 supervisor 状态
qq-files/<版本>/       # 解包后的 wrapper.node 与依赖缓存
tmp/                   # 下载临时文件
runtime/7zip/7zz       # Linux 7-Zip 缓存
```

## 全局字段

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `dataDir` | string | `<项目根>/.napuketto` | 数据根，支持 `~` 与相对路径 |
| `autoRestart` | boolean | `true` | supervisor 是否自动重启崩溃账号 |
| `restartDelayMs` | 正整数 | `2000` | 重启延迟（毫秒） |
| `accounts` | 数组 | 必填 | 至少一个账号，见「账号」 |

## 日志段

不写 `[log]` 即全缺省：格式按 TTY 自动（终端 pretty，管道 single-line），级别 `info`，
打印启动 banner。字段与合法值：

```toml
[log]
format = "single-line"   # pretty | single-line | json；缺省按 TTY 自动
level = "info"           # trace / debug / info / warn / error / fatal / silent
banner = true            # 启动字符画；supervisor 子进程自动关闭
timestamp = "local"      # local | iso8601 | elapsed（json 格式恒为 ISO8601）
unboundReceive = true    # false = 不打未绑定频道的接收行（kurobot 握手后生效）
[log.levels]             # 按模块覆盖控制台级别：cli / kernel / loader / ob11
# loader = "debug"
[log.file]               # 可选独立文件 sink；路径相对数据根
# path = "logs/napuketto-console.log"
# level = "debug"        # 文件级别可低于控制台
```

`[log.file].level` 缺省跟随全局；`[log.levels]` 只接受上述四个模块名，未知键报错。

## 账号

```toml
[[accounts]]
qq = "10001"          # 必填，5-11 位纯数字；模板占位 123456 / 654321 会被拒绝
enabled = true        # 可选，默认 true；supervisor 只拉起启用的账号
[accounts.onebot11]   # 协议段嵌在账号内
[accounts.satori]
```

- 写哪个协议段就启用哪个协议；没写的协议不装配（OB11 例外，见下节）。
- `-q <uin>` 单账号启动绕过 `accounts` 列表与 `enabled` 过滤，直接拉起该 uin。
- 登录后按实际 uin 匹配 `accounts` 中的 `qq`，两者应一致；不一致时以 uin 为准。

## 协议段

| 协议 | 启用条件 | 高频字段 | 文档与 schema |
|---|---|---|---|
| OneBot 11 | 始终装配，缺段用默认值 | token、httpServers、wsServers | [onebot11.md](../protocols/onebot11.md) / [schema](../../packages/adapter/src/onebot11/helper/config.ts) |
| Satori | 账号段非空 | token、httpServers、wsServers | [satori.md](../protocols/satori.md) / [schema](../../packages/adapter/src/satori/helper/config.ts) |
| KuroBot | 账号段非空且含 url | url、token、commandPrefix | [kurobot.md](../protocols/kurobot.md) / [schema](../../packages/adapter/src/kurobot/config.ts) |
| Milky | 账号段非空且 enabled=true | enabled、host、port、token | [milky.md](../protocols/milky.md) / [schema](../../packages/adapter/src/milky/config.ts) |

全量字段、默认值与传输实例见各协议 schema；Milky 的 `enabled` 缺省 `false`，未开启不监听。

## 环境变量

| 变量 | 作用 |
|---|---|
| `NAPKETTO_CONFIG_JSON` | 内联配置 JSON（最高优先级） |
| `NAPKETTO_CONFIG` | 配置文件路径（显式覆盖） |
| `NAPKETTO_DATA` | 数据根 |
| `NAPUKETTO_LOG_LEVEL` | 日志级别覆盖 |
| `NAPUKETTO_LOG_FORMAT` | 输出格式覆盖 |
| `NAPUKETTO_NO_BANNER` | `1`/`true` 关闭启动 banner |
| `NAPUKETTO_LOG_COLORIZE` | 颜色开关（子进程传播） |
| `NAPUTO_QQ_PATH` | 本机 QQ 安装路径 |
| `NAPUTO_QQ_FILES` | QQ 文件根（含 `versions/`） |
| `NAPUTO_QQ_URL` | QQ 安装包下载地址 |
| `NAPUTO_STUB_DIR` | stub `QQNT.dll` 目录 |
| `NAPUTO_LINUX_STUB` | Linux `.so` stub 路径 |
| `NAPUTO_7Z_PATH` | 7-Zip 可执行文件 |
| `NAPUTO_7Z_URL` | Linux 7zz 下载地址 |
| `NAPUTO_WIN_NODE_PATH` | 非 Node 宿主用 `node.exe` |
| `NAPUTO_QUICK_UIN` | 强制快速登录账号 |
| `NAPUTO_QR_ONLY` | 强制扫码登录 |
| `NAPUTO_SMOKE` | 启动后收发冒烟自检 |
| `NAPUTO_SMOKE_PEER` | 冒烟自检对端 |
| `NAPUTO_PROBE` | 运行时探测（诊断） |

日志变量的旧拼写 `NAPKETTO_LOG_LEVEL` 仍被接受（`NAPUKETTO_` 优先）。

`NAPUTO_KERNEL_ENTRY`、`NAPUTO_ADAPTER_ENTRY`、`NAPUTO_CFG_DIR`、`NAPUTO_IPC` 等由
CLI/loader 注入，正常部署不要手工设置。

## 验证与常见排障

- `napuketto config validate` 返回 0 表示合法；78 表示 ConfigError，宿主不会自动重启。
- 启动日志出现 `配置来源: inline（NAPKETTO_CONFIG_JSON）` 说明走内联，否则为文件来源。
- 报「缺少 accounts」或占位 QQ 号时编辑模板对应段；`qq` 必须是 5-11 位真实号码。
- 协议未监听：确认协议段非空（Milky 还需 `enabled = true`）且端口未被占用。
- 内联内容超 32KB 或需要热更新时，改用 `NAPKETTO_CONFIG` 指向的 TOML 文件。
