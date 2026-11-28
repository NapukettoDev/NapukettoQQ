# @napuketto/cli 模块设计

> 本文件记录 `apps/cli/src` 的目录边界与依赖规则，是后续迭代的架构护栏。新增文件先确认
> 归属目录；跨目录依赖先对照「配置来源口径」。命令/选项/stdout/退出码/配置优先级以源码与
> `docs/guides/configuration.md` 为准，本文件不重复。

## 目录树与职责

```text
apps/cli/src/
├── index.ts                     # 进程入口：shebang + main()，不写业务
├── logger.ts                    # 进程级日志单例 + [log] 段解析 + 控制台渲染决策
├── cli/                         # commander 适配层（对外契约）
│   ├── program.ts               # 全局选项、banner、子命令注册、默认动作分发
│   ├── version.ts               # cliVersion()：运行时读自身 package.json 的 version
│   └── error.ts                 # handleActionError：ConfigError -> 78，其余 -> 1；预期错误单行日志
├── commands/                    # 用例实现（不 import commander）
│   ├── start.ts                 # 默认动作：-q 单账号 / 多 -q / 无 -q 读配置（-q 入口校验）
│   ├── config.ts                # config init/list/apply/validate（输出脱敏）
│   └── ops.ts                   # status/stop/restart（-q 入口校验）
├── config/                      # 配置领域
│   ├── schema.ts                # CliConfig 类型 + parseCliConfig + QQ 号校验（主配置/-q 共用）
│   ├── inline.ts                # NAPUKETTO_CONFIG_JSON 文本/文档/严格解析
│   ├── template.ts              # TOML 模板文本
│   └── store.ts                 # CliConfigStore + 默认值 + 模板落盘 + 来源决议/加载
└── runtime/                     # 进程运行期
    ├── boot.ts                  # 单账号自建宿主启动（账号目录边界校验）
    ├── lines.ts                 # 子进程输出逐行切分（单行缓冲上限，boot/supervisor 共用）
    ├── qr.ts                    # 终端二维码渲染（uqr 编码 + 白底黑块 ANSI）
    ├── supervisor.ts            # 多账号子进程编排（显式 -q 去重拒绝）
    └── state.ts                 # runtime.json + pid/树杀/detached + 状态聚合（路径边界）
```

顶层只允许 `index.ts` 与 `logger.ts`。`logger.ts` 是唯一的跨切面单例：
它需要读主配置的 `[log]` 段，因此允许依赖 `config/inline.ts`（叶子模块），
但 `config/inline.ts` 不得反向依赖 logger。

## 各层允许的依赖

```text
index        -> cli
cli          -> commands, config (仅类型), logger
commands     -> config, runtime, logger
runtime      -> config, logger, @napuketto/kernel, @napuketto/loader, uqr（仅 qr.ts）
config       -> logger, @napuketto/kernel
logger       -> @napuketto/kernel, config/inline（只读叶子）
```

**终端二维码为什么自己画**（`runtime/qr.ts`）：uqr 自带的 `renderANSI` 每模块占一个
全角空格（U+3000），宽度翻倍，登录 URL 编码出的 40+ 模块在 80 列终端里折行即废码；
`renderUnicodeCompact` 用默认前景色画亮模块，极性跟着终端主题走（浅色主题下反色）。
所以只取 uqr 的 `encode`，按旧 qrcode `terminal + small` 的白底黑块 half-block 自行
绘制：与主题无关、宽度 = 模块数。`runtime/qr.test.ts` 把渲染结果解析回矩阵做
roundtrip 断言，替代此前无法测试的第三方渲染路径。

**版本号为什么读文件**（`cli/version.ts`）：`--version` 曾经是 `program.version("0.0.1")`
硬编码字面量，发到 0.5.x 仍自报 0.0.1（补发后装机冒烟发现）。改为运行时读
自身 `package.json` 的 `version`，候选 `../package.json`（生产 tsdown 单文件 `dist/index.mjs`）
与 `../../package.json`（源码直跑），并要求 `name === "@napuketto/cli"` 防读错文件；
全失败兜底 `0.0.0-unknown` 且不抛错——版本号缺失不该让 CLI 起不来。发版只改
`package.json` 一处，`cli/version.test.ts` 断言读到的值等于包版本，防止再退化成字面量。

禁止项：

- `config` -> `cli` / `commands` / `runtime`
- `runtime` -> `commands` / `cli`
- `commands` -> `cli`（用例层不得反向依赖 commander）
- 任何模块 import `index.ts`
- `config/inline.ts` import `store.ts` / `logger.ts`（保持叶子，避免 logger 环）

## 配置来源口径（刻意不合并）

OneBot 11、Satori 与 Milky 的 `media.outboundPolicy` 由各协议 schema 校验。
模板标注默认 `public-only`，受信任的 LAN 媒体服务可在对应账号协议段显式设为 `compat`。
内联配置使用相同的 `accounts[].<protocol>.media.outboundPolicy` 结构。

cli 内部的读取分两档，调用方必须按场景选择：

| 入口 | 严格度 | 使用方 |
|---|---|---|
| `parseInlineConfig` | 严格：JSON 失败/非对象/字段失败 -> `ConfigError`（exit 78） | 主配置加载、`config validate` |
| `readInlineConfigSection` | 宽松：坏文档 -> `undefined` | logger 读 `[log]` 段（日志配置损坏不阻塞启动） |

来源决议统一走 `config/store.ts` 的 `resolveCliConfigSource`：
`NAPUKETTO_CONFIG_JSON` 非空 -> inline；否则按 kernel `resolveConfigPath`
（`NAPUKETTO_CONFIG` > 项目根探测 > 数据根兜底）解析文件路径。`config validate`
无参分支复用同一个决议，但保持只读（不落模板）。内联键只认规范前缀；历史拼写不再双读，
来源日志固定输出 `NAPUKETTO_CONFIG_JSON`。

**不把该逻辑下沉到 kernel**：loader 引导进程编译期只依赖 zod、运行期通过
`KernelLike` 动态 import kernel，且其策略是“坏配置回退、不阻塞引导”，与 cli 的
strict/78 契约相反。两套读取是有意分层，不是重复实现。只有出现第三个消费者、
loader 需要严格校验、或内联契约再次变化时，才评估在 kernel 提供纯函数原语
（env 键、文本读取、JSON 对象解析），并由 loader 经 `KernelLike` 特性探测采用。

**`config validate` / `config apply` 的协议段校验**：主配置解析保持协议段为宽松对象，
但这两条路径会懒加载 `@napuketto/adapter` 的四个协议 schema，对**非空**协议段做与
loader 装配同口径的字段校验（空段 = 不启用，跳过）。`config apply` 必须在写盘前完成
同一层校验，否则非法协议段会落进主配置、演化成「apply 通过但启动 exit 78」。
普通启动与 supervisor 不加载协议包。新增协议时要同步登记进
`config/protocol-validate.ts`。

各账号的 OB11、Milky、Satori 可配置 `media.localMediaRoots`。模板缺省空数组，
现有集成可将共享媒体或导出目录加到对应账号协议段。路径基准与 IPC 相同，参考[配置指南](../../../docs/guides/configuration.md)。

OB11 模板列出账号级 `media.messageBudget`，CLI 配置检查复用 OB11 schema 校验项数及字节上限。

## 仓库外调试沙箱

仓库根的调试入口在加载 CLI 前设置沙箱 cwd、绝对配置路径与数据根，并通过
`NAPUKETTO_SANDBOX_ROOT` 将写入边界传给 supervisor、账号进程与自建宿主。
CLI 按原有优先级处理内联配置和命令行参数，沙箱内的写目标经真实路径检查。
`--data-dir`、配置中的数据目录、日志和协议缓存若越界，按配置错误退出。
启动入口在同一 Node 进程加载 CLI，`process.argv[1]` 指向真实构建产物，供
supervisor 与 `restart` 派生进程使用。终端与信号由 CLI 原有处理器接管。

## 凭据保护口径

- **stdout 脱敏**：`config list` / `config apply` 输出 TOML 时，`token` 等敏感字段
  默认替换为 `***`；`--show-secrets` 才输出明文。写盘始终使用未脱敏配置。
- **落盘权限**：主配置文件在 POSIX 以 `0o600` 写入（kernel `CONFIG_FILE_MODE`），
  避免协议 token 被同机其他用户读取；Windows 以 ACL 为准，忽略 mode 位。

## runtime 进程治理口径

- **`-q` 入口校验**：`-q` 不是自由文本账号名，必须复用 `config/schema.ts` 的 QQ 号
  规则（5-11 位纯数字、拒绝模板占位值）。`commands/start.ts` 与 `commands/ops.ts`
  在分发前校验并拒绝重复值；`runtime/state.ts` 的 `accountDir` 再做一次数据根边界
  防御（拒绝绝对路径/分隔符/越界），`boot.ts` 拒绝停止哨兵保留值 `all`——否则
  `-q ../../x` 会把 runtime.json 写出数据根、`-q all` 会污染全局 `napuketto.stop`。
- **退出码透传**（issue #144）：单账号 boot 等待 self-host 退出时，非停止状态下的异常
  退出码（含 `78`）必须透传给 boot 进程；收到停止请求恒 `0`。supervisor 依赖 `78` 判定
  「配置未修复、不守护重启」，boot 吞码会让该契约失效、把配置失败变成无限重启。
- **单账号收尾释放**：`runSingleAccount` 在 `waitSelfHostExit` 的 `finally` 调用
  `installGracefulStop` 句柄的 `dispose`，统一 `process.off` 三个信号监听、取消
  `watchStopSentinel` 轮询并清理 10s kill 兜底定时器；否则常驻结束后仍残留 handler 与
  定时器（同进程复用/测试隔离都会被污染）。
- **`--qq-path` 透传**：无 `-q` / 多 `-q` / `supervisor` 子命令进入编排时，
  `SupervisorOptions.qqPath` 必须随子进程参数（`--qq-path`）与 runtime.json cmdline
  指纹一起透传；多账号共用同一份 QQ 原生文件覆盖，不能静默回退本机安装/下载来源。
- **子进程输出行上限**：boot / supervisor 统一走 `runtime/lines.ts`，不用无上限的
  readline 单行缓冲；单行超过 64 KiB 截断并补 `…[truncated]`，避免原生层无换行异常
  输出把内存打满。
- **守护重启退避**（issue #144）：子进程运行不足 30s 视为连续秒退，重启延迟按
  `restartDelayMs × 2^n` 增长、60s 封顶；稳定运行超过 30s 清零退避计数。日志打印连续
  失败次数与下次延迟，避免登录后秒退演变成高频循环重登（易触发 QQ 风控）。
- `runtime/state.ts` 汇出兼容接口。状态文件读写与路径边界在 `state-store.ts`，
  进程生命周期操作在 `process-control.ts`，PID 身份校验在 `process-identity.ts`，
  `status-view.ts` 组合磁盘状态与进程存活结果供 `status` 使用。
- **runtime.json 写入权责**：supervisor 与受管 boot 共享同一账号状态文件，supervisor
  拥有 `kind`/`restartCount`/启动时间与 boot pid，受管 boot 通过
  `SUPERVISOR_CHILD_ENV`（supervisor spawn 时注入）识别托管模式，只以
  `patchAccountRuntime` 合并补充 `selfHostPid`/`selfHostCmdline` 与生命周期状态；退出时
  双方都走合并写，禁止整文件覆盖。`status` 聚合输出 `kind`、`selfHostPid` 与
  `restartCount`，便于区分托管子进程与单账号 boot。
- **状态文件原子写**：`runtime.json` / `supervisor.json` 统一走「同目录唯一临时文件 +
  rename」（Windows 由 libuv 以 `MOVEFILE_REPLACE_EXISTING` 覆盖，不先删目标），
  异常时清理临时文件；并发 `status`/`stop` 不会读到截断 JSON。
- **supervisor 空闲退出**：追踪每条守护重启的定时器（`pendingRestarts`），`stopAll`
  统一 `clearTimeout`；当 `children` 与 `pendingRestarts` 均空时结束常驻——
  `autoRestart=false` 全部退出收尾为 0，全部因 `78` 退出透传 `78`，其他异常收尾为 1。
- **树杀安全**：`killProcessTree` 在 POSIX 先 SIGTERM，宽限后对仍存活目标（含进程组与
  `selfHostPid`）补 SIGKILL；Windows 监听 `taskkill` 的 `error` 事件。`ops` 在杀
  supervisor / 账号前用记录的命令行参数指纹做 PID 复用校验（`checkProcessIdentity`，
  规范化子串比对），不匹配则跳过并告警；旧状态无指纹时保持旧行为。
- **单账号哨兵隔离**：`stop -q <uin>` 写 `<数据根>/napuketto.stop.<uin>` 独立文件而非
  覆盖全局单文件，并发 stop 不同账号互不覆盖/提前删除；全局 `all` 仍走
  `napuketto.stop`。`cmdRestart` 在 `cmdStop` 置非 0 退出码或 `process.argv[1]` 为空时
  立即中断，不 detached 拉起空 `node` 进程。

## 类型检查与构建

包级 `tsconfig.json` 继承根编译选项，独立检查 `src`。`tsc -p apps/cli` 沿用
`noEmit`，发布入口 `dist/index.mjs` 和声明 `dist/index.d.mts` 由 tsdown 生成。

## 测试布局
测试收拢在包根 `tests/` 下（镜像 `src/` 子目录结构），文件名对应被测模块；
跨模块的领域套件可用领域名：

```text
tests/cli/error.test.ts
tests/commands/config.test.ts
tests/commands/ops.test.ts
tests/commands/start.test.ts
tests/config/inline.test.ts
tests/config/schema.test.ts
tests/config/store.test.ts
tests/config/source.test.ts   # inline + store 来源优先级
tests/config/template.test.ts   # 配置模板段落归属
tests/runtime/boot.test.ts
tests/runtime/lines.test.ts     # 逐行切分 + 无换行超长行截断
tests/runtime/state.test.ts
tests/runtime/supervisor.test.ts
tests/runtime/qr.test.ts      # 终端二维码渲染（uqr 矩阵 roundtrip）
tests/logger.test.ts
```

约束：

- 同一条领域规则只在一个测试文件断言（例如占位 QQ 号规则归
  `tests/config/schema.test.ts`），其他文件只验证该路径把 `ConfigError` 透出。
- 搬移文件后必须核对 `vi.mock` 说明符：它按测试文件位置解析，tsc 不会报错。
- POSIX-only 用例（环境变量大小写别名）保持 `it.runIf(process.platform !== "win32")`。

## 变更检查清单
- [ ] 新文件归属明确；顶层不再新增散落模块
- [ ] `cli/` 只做参数/帮助/输出/退出码，不写业务编排
- [ ] `commands/` 不 import commander
- [ ] `config/` 不 import runtime/commands/cli
- [ ] 新增配置读取前先读「配置来源口径」，确认 strict/lenient 口径
- [ ] `pnpm check`、`pnpm exec vitest run`、`pnpm exec fallow audit --base origin/main` 全绿
- [ ] 对外 CLI 契约（命令/选项/stdout/退出码）无变化时不需要 changeset
