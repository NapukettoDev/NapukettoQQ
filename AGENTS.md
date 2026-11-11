# NapukettoQQ 工程指南

> 项目级指令（VS Code Copilot 自动加载）。开工顺序：本文件 → [docs/README.md](docs/README.md)
> → [overview](docs/architecture/overview.md) → [runtime](docs/architecture/runtime.md) →
> 对应包的 `docs/design.md`。

## 项目是什么

NapukettoQQ：基于 QQ NT 客户端原生模块（`wrapper.node`）的自托管机器人框架，对外提供
Milky、OneBot 11、Satori 与 KuroBot 群服互通（OneBot 12 已放弃）。全自研：pnpm
monorepo + TypeScript + tsdown + biome，MIT；Node.js ESM，包名 `@napuketto/*`。
Koishi 适配器（`koishi-plugin-adapter-napuketto`）是独立仓库，不在本仓 workspace / CI /
发布链内，只依赖 npm 上已发布的 `@napuketto/*`；跨仓联调走 `pnpm pack` 或 prerelease，
不要恢复 workspace link（否则测的不是发布形态）。

## 硬性约束（违反 = 错误）

1. **许可证**：MIT，零引入 GPL-2.0-only 实现代码——任何文件（含类型定义）不得复制/移植；
   接口签名是外部系统事实，实现必须原创。**闭源例外**：`packages/loader/native` 私有
   submodule 只分发编译 stub（RVA/Offset 不进公共仓库），clone 后跑 `git submodule update --init --recursive`。
2. **依赖方向**（只允许向下）：

   ```
   @napuketto/kernel / media / network   无内部依赖
   @napuketto/adapter                    kernel + network + media
   @napuketto/loader                     编译期仅 zod；运行期动态 import kernel
   apps/cli                              kernel + network + adapter + loader
   apps/napuketto-create                 @napuketto/cli
   ```

3. **kernel 是唯一原生交互层**：只有 `packages/kernel` 允许 `process.dlopen`、访问
   `wrapper.node`、注册原生 listener；其他包只调语义 API、订阅事件、读缓存。
4. **network 协议无关**：不得 import 协议包，事件类型必须泛型化。
5. **不做的事**：framework 模式、WebUI、插件系统、Proxy 事件老方案、无理由的 `any`；
   功能范围 = 完整协议 + API 能力 − WebUI − 插件系统。**media 严格解耦**：只被协议层
   依赖，kernel 不背媒体依赖。
6. **运行路线与逆向边界**：自建宿主是唯一路线（标准 Node + stub：Windows PE `QQNT.dll`，
   Linux ELF + `LD_PRELOAD`），注入 QQ / worker 路线已淘汰。允许为实现协议能力做必要逆向
   （环境模拟、数据包层、无头阻断），业务层优先官方 NAPI；技术手段仅限 loader 私有 native
   组件。**零磁盘篡改**：只允许运行期内存操作，严禁改 QQ 安装目录二进制；逆向产物只存私有。
7. **配置单一来源**：项目根 `napuketto.toml`，账号必填，协议段嵌在 `[[accounts]]` 内
   （可选协议没写 = 不启用；OB11 缺段按空传输装配）。数据根默认 `<项目根>/.napuketto`，
   优先级 `--data-dir` > `NAPKETTO_DATA` > 默认。`NAPKETTO_CONFIG_JSON` 可注入同构 JSON
   （优先级最高，生效时零 toml 落盘）；配置校验失败以退出码 78 表示（宿主不重启）。

## 工作流

```bash
pnpm install            # 安装依赖（根 prepare 配 git hooks 并全量构建）
pnpm check              # biome + tsc + check:docs，提交前必跑
pnpm fix                # biome 自动修复 + tsc + check:docs
pnpm test               # vitest 全量单测
pnpm -r build           # 全量构建（tsdown）
pnpm --filter @napuketto/kernel dev   # 单包 watch 构建
pnpm changeset          # 随改动记录版本 bump
pnpm release:dryrun     # 本地演练：升版本 + 构建 + npm publish --dry-run
```

**一切改动走 PR**：main 由 ruleset 保护（PR + 1 审批 + merge queue + 必需检查 + 签名 +
CodeQL）。分支提交 → PR → CI（`gate` / `windows` / `audit`）全绿 → squash 合并；仅发布链
版本提交可直推 main，其余（含文档、CI）都走 PR。

**Changesets（强制，勿攒）**：每个用户可见改动（feat / fix / refactor 涉发布内容）必须随
改动在 `.changeset/` 写条目；API 破坏 → `minor`（0.x），修复 → `patch`，依赖联动自动
处理。漏写会导致 `changeset version` 无条目、版本与 CHANGELOG 不更新。纯 chore（文档、
lockfile、子模块指针、删脚本、无行为变化的改名）不需要。

**发布**：合并带 changeset 的 PR 触发 `.github/workflows/release.yml`——`prepare` 消费
changeset、构建、测试、推版本提交与 per-package tag（`<包名>@<版本>`），`publish` 在
`release` environment 审批后走 npm OIDC（无长期 token，自动 provenance）。GitHub Releases
只发 `milestone-<线>`；补发用 `workflow_dispatch` + `skip-version`（不打 tag）。发不出包
先查 `.changeset/` 是否有 pending 条目；本地 `pnpm release` 只作演练/应急。

**lockfile 钩子**：根 `prepare` 设 `core.hooksPath tooling/git-hooks`；暂存 package.json /
pnpm-workspace.yaml / native 指针而未带 `pnpm-lock.yaml` 时自动校验，有 diff 即拒绝提交；
绕过用 `--no-verify`（不推荐）。任何日志与文档都不得打印凭证。

## 代码风格（biome 已强制）

- 缩进 4 空格，LF；类型导入用 `import type`；禁止裸 `any`（例外注释原因）。
- `strict` 全家桶、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、
  `verbatimModuleSyntax`、`noUnusedLocals/Parameters` 均为 error；kernel 无全局单例：
  logger / cache / event-channel 由 `CoreContext` 或装配层持有。
- `noFloatingPromises`：异步调用必须 `await` 或显式 `.catch`；业务错误抛类型化错误
  （kernel 用 `KernelError`），不静默吞；日志统一走 pino。

## 实现模式

- **设计先行**：写代码前先更新对应包 `docs/design.md`；改跨包契约同步 `docs/architecture/`。
- **一个模块一个模块实现**：按 design 的实现顺序推进，不跨模块跳跃；每完成一个模块跑
  `pnpm check`。
- **类型层来自运行时探测**：`services/listeners/entities` 类型由加载 `wrapper.node` 后
  反射 + 实体 JSON 观察产出，不拍脑袋、不抄别家；探测代码在 `kernel/src/wrapper/probe/`。
- **新增协议**：在 `packages/adapter` 内新增目录，复用 core 框架（生命周期/订阅/广播/校验），不改 network、不改 kernel。
- **文档红线**：严禁向 `design.md` 追加带日期的进度记录或 >15 行 JSON 样本；实测数据写同级 `docs/evidence.md`。
