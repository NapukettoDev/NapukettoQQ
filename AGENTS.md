# Napuketto 工程指南

> **上下文省流铁律（必读）**：
>
>
>
> 1. **按需读文档**：严禁开局通读所有文档。仅在修改具体包时读取对应包的 `packages/<pkg>/docs/design.md`；涉及跨包契约变更时才读 `docs/architecture/`。
> 2. **禁止全量刷屏**：日常验证优先用 `pnpm --filter <包名>` 针对单包执行。跑测试或检查必须精简输出（如 `vitest run <文件> --reporter=dot`），严禁无脑跑全量 `pnpm test` 把几百行 Pass 日志灌入上下文。

## 项目概览

Napuketto：基于 QQ NT 原生模块（`wrapper.node`）的自托管机器人框架，提供 Milky、OneBot 11、Satori 与 KuroBot 协议支持（OB12 已弃）。 技术栈：pnpm monorepo + TypeScript (ESM) + tsdown + Biome + Fallow，MIT 协议，包名前缀 `@napuketto/*`。

## 硬性约束（违反 = 错误）

1. **许可证与子模块**：MIT，实现必须原创。`packages/loader/native` 为私有 submodule，缺文件时跑 `git submodule update --init --recursive`。
2. **依赖方向（严格单向向下，由 Fallow `boundaries` 硬拦截）**：
   - 底层（无内部依赖）：`kernel` / `media` / `network`（`network` 必须协议无关、泛型化；`media` 仅被协议层依赖，`kernel` 不碰媒体）
   - 协议层：`adapter` → 依赖 `kernel + network + media`（四套协议彼此隔离）
   - 启动层：`loader` → 编译期仅依赖 `zod`，运行期动态 `import` kernel
   - 应用层：`apps/cli` → 依赖 `kernel + network + adapter + loader`；`apps/create` → 依赖 `cli`
3. **原生与逆向边界**：
   - **唯一原生层**：仅 `packages/kernel` 允许 `process.dlopen`、访问 `wrapper.node`、注册原生 listener；其他包只调语义 API、订阅事件、读缓存。
   - **自建宿主路线**：标准 Node + stub（Win PE `QQNT.dll` / Linux ELF `LD_PRELOAD`），注入/worker 路线已淘汰。业务层优先官方 NAPI，逆向仅限 loader 私有 native 组件。
   - **零磁盘篡改**：只允许运行期内存操作，严禁改 QQ 安装目录二进制。
4. **范围禁区**：不做 framework 模式、WebUI、插件系统、Proxy 事件老方案。
5. **配置单一来源**：根 `napuketto.toml`（账号必填，协议嵌在 `[[accounts]]` 内，未写 = 不启用，OB11 缺段按空传输装配）。 优先级：`NAPUKETTO_CONFIG_JSON`（最高，零落盘）> `--data-dir` > `NAPUKETTO_DATA` > `<根>/.napuketto`。 配置校验失败退出码固定为 `78`。

## 代码风格与红线

- **强类型（禁止虚假类型）**：内部模块契约、函数签名、返回值与状态模型必须使用具名强类型，严禁以 `Record<string, unknown>`、`object`、裸 `any`、`as unknown as` 或临时鸭子类型凑合过编译。外部不可信输入（JSON / TOML / IPC / HTTP / NAPI 反射）仅在入口边界接 `unknown`，并立刻通过 `zod` 或类型守卫收窄为明确类型；`Record<string, unknown>` 仅限类型守卫内部或真正的任意键值透传容器。
- **真实单测（禁止虚假单测）**：单测必须覆盖真实业务路径与可观察输出/副作用，严禁靠堆叠 `vi.mock` 掏空被测逻辑，或只断言 mock 自身被如何调用、返回预设假值（测 mock 不测代码）。仅允许在真实外部边界（`wrapper.node`、子进程/ffmpeg、网络、文件系统、时钟）使用最小化 fake / stub 或依赖注入；内部纯函数、协议编解码与状态机必须跑真实实现。
- **门禁冲突先请示**：若 Biome 或 Fallow 规则阻塞了本来直观清晰的实现（例如逼迫为压复杂度机械拆碎函数、为消重复强行耦合独立协议、或疑似工具误报），**严禁为了过门禁而扭曲代码、强拆函数或擅自加 ignore**——必须停下来说明触发规则与根因，先请示用户决定是重构代码还是调整工具规则。
- **格式与模块卫生**：4 空格 + LF；强制 `import type`（避免残留仅用于类型的运行时导入）；各包及协议公开入口禁止 `export *`，内部 barrel 可按需精简。
- **异步、错误与日志**：开启 `noFloatingPromises`（异步必 `await` 或 `.catch`）；业务抛类型化错误（如 `KernelError`），禁止静默吞错，仅在刻意 fail-soft 且原因或后果不明显时补一句注释；业务日志统一走 `pino`（严禁打印凭证），命令输出、宿主引导与 IPC 所需的 stdio 除外；`kernel` 无全局单例（状态由 `CoreContext` 或装配层持有）。
- **运行时类型探测**：`services/listeners/entities` 类型必须由 `kernel/src/native/probe/` 加载 `wrapper.node` 反射观察产出，严禁盲猜或抄袭。
- **扩展协议**：在 `packages/adapter` 新增目录并复用 core 框架，严禁为此修改 `network` 或 `kernel`。
- **注释红线**：注释只说明**当前不变量**与**外部踩坑根因**（原生 API 怪癖、平台边界、竞态/重入语义）。严禁写入日期戳、PR/issue/任务/阶段编号（`P0`/`Step x`/`阶段 x`）、文件拆分重构史，以及针对 linter 与复杂度门禁的解释；历史归 Git，不复读标识符名。

## 开发工作流（省上下文模式）

1. **设计先行**：写代码前先更新对应包 `docs/design.md`。**文档红线**：严禁向 `design.md` 追加带日期的进度记录或超过 15 行的 JSON 样本（实测数据写入同级 `docs/evidence.md`）。
2. **精准门禁命令**（严禁日常无脑跑全量 `pnpm test` 或 `test:coverage` / `test:health`；死代码与健康度仅按需手动审计，不作日常阻断）：

   ```
   # 1. 日常单包/单文件测试（静默日志 + 点状输出，省 90% 上下文）
   pnpm test:quiet packages/<pkg>                  # 测单个包
   pnpm test:quiet packages/<pkg>/tests/xxx.test.ts # 测单个文件

   # 2. 单包构建（避免全仓 pnpm -r build 刷屏）
   pnpm --filter @napuketto/<pkg> build

   # 3. 静态检查与自动修复（Biome + TS 7.0，成功时几乎零输出）
   pnpm fix

   # 4. 最终交卷前全量验证（静态检查 + 架构边界 + 全量静默测试）
   pnpm check && pnpm exec fallow architecture --boundaries && pnpm test:quiet
   ```
3. **版本记录（Changesets 强制）**：凡涉及用户可见改动（feat / fix / refactor），必须在 `.changeset/` 编写条目（0.x 阶段：破坏性改动用 `minor`，修复用 `patch`；纯文档/chore 无需编写）。
4. **提交约束**：一切改动走 PR；若修改了 `package.json`、`pnpm-workspace.yaml` 或 submodule 指针，必须同步提交更新后的 `pnpm-lock.yaml`（git hook 强制校验）。
