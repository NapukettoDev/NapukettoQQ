# @napuketto/cli 模块设计

> 本文件记录 `apps/cli/src` 的目录边界与依赖规则，是后续迭代的架构护栏。
> 新增文件先确认归属目录；跨目录依赖先对照第 3 节。
> 行为契约（命令、选项、stdout、退出码 0/78/1、配置优先级）以源码与
> `docs/guides/configuration.md` 为准，本文件不重复。

## 1. 目录树与职责

```text
apps/cli/src/
├── index.ts                     # 进程入口：shebang + main()，不写业务
├── logger.ts                    # 进程级日志单例 + [log] 段解析 + 控制台渲染决策
├── cli/                         # commander 适配层（对外契约）
│   ├── program.ts               # 全局选项、banner、子命令注册、默认动作分发
│   └── error.ts                 # handleActionError：ConfigError -> 78，其余 -> 1
├── commands/                    # 用例实现（不 import commander）
│   ├── start.ts                 # 默认动作：-q 单账号 / 多 -q / 无 -q 读配置
│   ├── config.ts                # config init/list/apply/validate
│   └── ops.ts                   # status/stop/restart
├── config/                      # 配置领域
│   ├── schema.ts                # CliConfig 类型 + parseCliConfig + 占位号常量
│   ├── inline.ts                # NAPKETTO_CONFIG_JSON 文本/文档/严格解析
│   ├── template.ts              # TOML 模板文本
│   └── store.ts                 # CliConfigStore + 默认值 + 模板落盘 + 来源决议/加载
└── runtime/                     # 进程运行期
    ├── boot.ts                  # 单账号自建宿主启动
    ├── supervisor.ts            # 多账号子进程编排
    └── state.ts                 # runtime.json + pid/树杀/detached + 状态聚合
```

顶层只允许 `index.ts` 与 `logger.ts`。`logger.ts` 是唯一的跨切面单例：
它需要读主配置的 `[log]` 段，因此允许依赖 `config/inline.ts`（叶子模块），
但 `config/inline.ts` 不得反向依赖 logger。

## 2. 各层允许的依赖

```text
index        -> cli
cli          -> commands, config (仅类型), logger
commands     -> config, runtime, logger
runtime      -> config, logger, @napuketto/kernel, @napuketto/loader
config       -> logger, @napuketto/kernel
logger       -> @napuketto/kernel, config/inline（只读叶子）
```

禁止项：

- `config` -> `cli` / `commands` / `runtime`
- `runtime` -> `commands` / `cli`
- `commands` -> `cli`（用例层不得反向依赖 commander）
- 任何模块 import `index.ts`
- `config/inline.ts` import `store.ts` / `logger.ts`（保持叶子，避免 logger 环）

## 3. 配置来源口径（刻意不合并）

cli 内部的读取分两档，调用方必须按场景选择：

| 入口 | 严格度 | 使用方 |
|---|---|---|
| `parseInlineConfig` | 严格：JSON 失败/非对象/字段失败 -> `ConfigError`（exit 78） | 主配置加载、`config validate` |
| `readInlineConfigSection` | 宽松：坏文档 -> `undefined` | logger 读 `[log]` 段（日志配置损坏不阻塞启动） |

来源决议统一走 `config/store.ts` 的 `resolveCliConfigSource`：
`NAPKETTO_CONFIG_JSON` 非空 -> inline；否则按 kernel `resolveConfigPath`
（`NAPKETTO_CONFIG` > 项目根探测 > 数据根兜底）解析文件路径。`config validate`
无参分支复用同一个决议，但保持只读（不落模板）。

**不把该逻辑下沉到 kernel**：loader 引导进程编译期只依赖 zod、运行期通过
`KernelLike` 动态 import kernel，且其策略是“坏配置回退、不阻塞引导”，与 cli 的
strict/78 契约相反。两套读取是有意分层，不是重复实现。只有出现第三个消费者、
loader 需要严格校验、或内联契约再次变化时，才评估在 kernel 提供纯函数原语
（env 键、文本读取、JSON 对象解析），并由 loader 经 `KernelLike` 特性探测采用。

## 4. 测试布局

测试与源码同目录，文件名对应被测模块；跨模块的领域套件可用领域名：

```text
cli/error.test.ts
commands/config.test.ts
commands/ops.test.ts
config/schema.test.ts
config/source.test.ts        # inline + store 来源优先级
runtime/state.test.ts
runtime/supervisor.test.ts
logger.test.ts
```

约束：

- 同一条领域规则只在一个测试文件断言（例如占位 QQ 号规则归 `config/schema.test.ts`），
  其他文件只验证该路径把 `ConfigError` 透出。
- 搬移文件后必须核对 `vi.mock` 说明符：它按测试文件位置解析，tsc 不会报错。
- POSIX-only 用例（环境变量大小写别名）保持 `it.runIf(process.platform !== "win32")`。

## 5. 变更检查清单

- [ ] 新文件归属明确；顶层不再新增散落模块
- [ ] `cli/` 只做参数/帮助/输出/退出码，不写业务编排
- [ ] `commands/` 不 import commander
- [ ] `config/` 不 import runtime/commands/cli
- [ ] 新增配置读取前先读第 3 节，确认 strict/lenient 口径
- [ ] `pnpm check`、`pnpm exec vitest run`、`pnpm exec fallow audit --base origin/main` 全绿
- [ ] 对外 CLI 契约（命令/选项/stdout/退出码）无变化时不需要 changeset
