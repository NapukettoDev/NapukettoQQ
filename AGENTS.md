# Napuketto 工程指南

> **上下文省流铁律（必读）**：
> 1. **按需读文档**：严禁开局通读所有文档！仅在修改具体包时，读取对应包的 `packages/<pkg>/docs/design.md`；涉及跨包契约变更时才读 `docs/architecture/`。
> 2. **禁止全量刷屏**：日常验证优先使用 `pnpm --filter <包名>` 针对单包执行。跑测试或检查时必须精简输出
>    （如 `vitest run <文件> --reporter=dot`），严禁无脑跑全量 `pnpm test` 把几百行 Pass 日志灌入上下文。

## 项目概览

Napuketto：基于 QQ NT 原生模块（`wrapper.node`）的自托管机器人框架，提供 Milky、OneBot 11、Satori 与 KuroBot 协议支持（OB12 已弃）。
技术栈：pnpm monorepo + TypeScript (ESM) + tsdown + biome，MIT 协议，包名前缀 `@napuketto/*`。

## 硬性约束（违反 = 错误）

1. **许可证与子模块**：MIT，实现必须原创。`packages/loader/native` 为私有 submodule，缺文件时跑 `git submodule update --init --recursive`。
2. **依赖方向（严格单向向下）**：
   - 底层（无内部依赖）：`kernel` / `media` / `network`（`network` 必须协议无关、泛型化；`media` 仅被协议层依赖，kernel 不碰媒体）
   - 协议层：`adapter` → 依赖 `kernel + network + media`
   - 启动层：`loader` → 编译期仅依赖 `zod`，运行期动态 `import` kernel
   - 应用层：`apps/cli` → 依赖 `kernel + network + adapter + loader`；`apps/create` → 依赖 `cli`
   - `.fallowrc.jsonc` 定义包间和包内依赖边界，CI 检查整仓。Biome 补查 adapter 的 `./core` 导入，
     因为该发布子路径与源码目录不同。
3. **原生与逆向边界**：
   - **唯一原生层**：仅 `packages/kernel` 允许 `process.dlopen`、访问 `wrapper.node`、注册原生 listener；其他包只调语义 API、订阅事件、读缓存。
   - **自建宿主路线**：标准 Node + stub（Win PE `QQNT.dll` / Linux ELF `LD_PRELOAD`），注入/worker 路线已淘汰。
     业务层优先官方 NAPI，逆向仅限 loader 私有 native 组件。
   - **零磁盘篡改**：只允许运行期内存操作，严禁改 QQ 安装目录二进制。
4. **范围禁区**：不做 framework 模式、WebUI、插件系统、Proxy 事件老方案。
5. **配置单一来源**：根 `napuketto.toml`（账号必填，协议嵌在 `[[accounts]]` 内，未写=不启用，OB11 缺段按空传输装配）。
   优先级：`NAPUKETTO_CONFIG_JSON`（最高，零落盘）> `--data-dir` > `NAPUKETTO_DATA` > `<根>/.napuketto`。
   配置校验失败退出码固定为 `78`。

## 代码风格与红线

- **TS / Biome 规范**：4 空格 + LF；强制 `import type`；禁止裸 `any`（特例需注释）。
  开启 `strict` 全家桶、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、
  `verbatimModuleSyntax`、`noUnusedLocals/Parameters`。
- **异步与状态**：开启 `noFloatingPromises`（异步必 `await` 或 `.catch`）。
  业务抛类型化错误（如 `KernelError`），禁止静默吞错。`kernel` 无全局单例，状态由
  `CoreContext` 或装配层持有。
- **日志与命令输出**：业务日志走 `pino`，严禁打印凭证。`packages/` 内禁止使用 `console`。
  CLI、脚手架和工具脚本可用 `console` 输出命令结果。宿主引导和 IPC 可按契约使用 stdio。
- **运行时类型探测**：`services/listeners/entities` 类型必须由 `kernel/src/native/probe/` 加载 `wrapper.node` 反射观察产出，严禁盲猜或抄袭。
- **扩展协议**：在 `packages/adapter` 新增目录并复用 core 框架，严禁为此修改 `network` 或 `kernel`。
- **注释红线**：注释只说明**当前不变量**与**外部踩坑根因**（原生 API 怪癖、平台边界、竞态/重入语义）。
  严禁写入日期戳、PR/issue/任务/阶段编号（`P0`/`Step x`/`阶段 x`）、文件拆分重构史，
  以及针对 linter 与复杂度门禁的解释；历史归 Git，不复读标识符名。
  best-effort 忽略错误时，只在原因或后果不明显时说明。

## 开发工作流（省上下文模式）

1. **设计先行**：写代码前先更新对应包 `docs/design.md`。**文档红线**：严禁向 `design.md`
   追加带日期的进度记录或超过 15 行的 JSON 样本（实测数据写入同级 `docs/evidence.md`）。
2. **精准门禁命令**（严禁直接跑全量 `pnpm test` 或 `test:coverage` / `test:health`）：
   ```bash
   # 1. 日常单包/单文件测试（静默日志 + 点状输出，省 90% 上下文）
   pnpm test:quiet packages/<pkg>                  # 测单个包
   pnpm test:quiet packages/<pkg>/tests/xxx.test.ts # 测单个文件

   # 2. 单包构建（避免全仓 pnpm -r build 刷屏）
   pnpm --filter @napuketto/<pkg> build

   # 3. 静态检查与自动修复（Biome + TS 7.0，成功时几乎零输出）
   pnpm fix

   # 4. 最终交卷前全量验证
   pnpm check && pnpm exec fallow architecture --boundaries && pnpm test:quiet
   ```

   Fallow 的复杂度、重复和死代码按需审阅。增量审阅可用 `pnpm exec fallow audit --base origin/main`。


3. **版本记录（Changesets 强制）**：凡涉及用户可见改动（feat / fix / refactor），必须在 `.changeset/` 编写条目
   （0.x 阶段：破坏性改动用 `minor`，修复用 `patch`；纯文档/chore 无需编写）。
4. **提交约束**：一切改动走 PR；若修改了 `package.json`、`pnpm-workspace.yaml` 或 submodule 指针，
   必须同步提交更新后的 `pnpm-lock.yaml`（git hook 强制校验）。

