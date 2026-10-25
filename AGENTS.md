# NapukettoQQ 工程指南

> 本文件是项目级指令（VS Code Copilot 自动加载）。开始任何工作前，先读本文件与 `docs/README.md`（文档导航）→ `docs/architecture/overview.md`（架构总览）→ `docs/architecture/runtime.md`（运行链路）→ 对应包的 `docs/design.md`。

## 项目是什么

NapukettoQQ：基于 QQ NT 客户端原生模块（`wrapper.node`）的机器人框架，对外提供 OneBot 11、Satori 协议接口，并提供 KuroBot 群服互通（**OneBot 12 已放弃**，规范过于模糊）。**全自研**，pnpm monorepo + TypeScript + tsdown + biome。

**Koishi 适配器（`koishi-plugin-adapter-napuketto`）自 2026-10-18 起是独立仓库**（`NapukettoDev/koishi-plugin-adapter-napuketto`）：不在本仓 workspace / CI / 发布链里，也不再用 submodule 指针——它只依赖 npm 上已发布的 `@napuketto/*`，自有 lockfile/CI/版本。跨仓联调走 `pnpm pack` tarball 或 prerelease，不要恢复 workspace link（否则测的不是发布形态）。

## 硬性约束（违反 = 错误）

1. **许可证 MIT（2026-08-06 由 GPL-3.0 迁移），零引入 GPL-2.0-only 实现代码**。GPL-2.0-only 与 MIT 不兼容，任何文件（含类型定义）都不得复制或移植自此类项目。接口签名是外部系统（腾讯 wrapper.node）的事实，可以自研描述，但架构与实现必须原创。
   **闭源例外**：`@napuketto/loader` 的 `native/` 为私有组件——
   逆向腾讯 QQ 的产物（RVA/Offset 表）绝不进公共仓库，仅分发编译后的二进制（**2026-08-07
   用户拍板：不做混淆**——stub 仅含公开符号表+空函数，无机密可护，混淆徒增误报风险）；
   公共仓库只含 loader 的 TS 引导代码与对 stub 的引用。
   **2026-08-07 起 `native/` 为 Git Submodule（private 仓库 NapukettoDev/NapukettoQQ-Native）**：
   clone 主仓库后需 `git submodule update --init --recursive`；子仓库内容不进主仓库历史。
2. **依赖方向**（只允许向下依赖）：

   ```
   @napuketto/kernel    无内部依赖（pino + pino-pretty + smol-toml）
   @napuketto/media     无内部依赖（silk-wasm / file-type / image-size / execa）
   @napuketto/network   无内部依赖（hono / ws，协议无关传输原语）
   @napuketto/adapter   kernel + network + media（协议适配器容器：core 框架 + onebot11 / satori / kurobot）
   @napuketto/loader    编译期仅 zod；运行期动态 import kernel（NAPUTO_KERNEL_ENTRY）
   apps/cli             kernel + network + adapter + loader
   apps/napuketto-create  @napuketto/cli
   ```

3. **kernel 是唯一原生交互层**：只有 `packages/kernel` 允许 `process.dlopen`、访问 `wrapper.node`、注册原生 listener。其他包只能调 kernel 的语义化 API、订阅事件通道、读缓存。
4. **network 协议无关**：`@napuketto/network` 不得 import 任何协议包（adapter 等），事件类型必须泛型化。
5. **不做的事**：framework 模式（QQNT 插件）、webui、插件系统、Proxy 事件老方案、无理由的 `any`。**功能范围 = 完整协议 + API 能力 − WebUI − 插件系统**（2026-08-06 用户拍板）。
6. **media 严格解耦**：`@napuketto/media` 只被协议层（adapter）依赖，kernel 不背媒体依赖。
7. **技术路线（自建宿主唯一路线，2026-08-07 定稿）**：
   - **⚠️ 关键决策点**：**自建宿主为唯一路线（已全链路验证）**（标准 Node 纯 Node 模式，实测约 237MB），路线 B（注入 worker）已淘汰（2026-08-07 用户拍板）。路线演进结论见 `docs/architecture/decisions.md`。
   - **架构文档**：`docs/architecture/overview.md`（分层/包结构/红线）+ `docs/architecture/runtime.md`（启动链/登录/数据流）。
   - **业务层（JS/NAPI）**：kernel/adapter/network/media/cli 继续纯 NAPI 调用 `wrapper.node` 业务 API（getMsgService 等），现有 79 个 OneBot 动作（含别名变体）全保留。
   - **引导层（loader）**：`@napuketto/loader` 负责**自建宿主引导**（`launchSelfHost`：标准 node + stub QQNT.dll → dlopen wrapper.node，唯一路线）+ 无头阻断（自建宿主无 QQ 进程/UI，天然满足）。**路线 B（注入 QQ 主进程 → fork worker）已淘汰（2026-08-07 用户拍板）**；V1 注入框架与 V2 载具已移除（历史实现查 git 历史），本包不再编译 C++ 组件（仅保留闭源 stub QQNT.dll）。载具 DLL 历史职责（当前不需要）：① NOP `wrapper.node` 环境自检与 self-register 校验 ② 激活 session `cpp_impl` ③ 阻断 Chromium UI/GPU/Renderer 进程。
   - **⚠️ 逆向边界（2026-08-06 用户拍板：允许必要逆向，非 0 逆向）**：
     - **允许逆向的用途**（为实现完整协议/API 能力所需）：
       a. **环境模拟/反风控**：进程名伪装、模块隐藏（K32EnumProcessModules/GetModuleHandleW）、内存 RWX→RX、窗口类（napi2native 自研等价物；实测自建宿主非必要，保留无害）
       b. **数据包层**：C++ 层 hook 数据包 send/recv（Frida Gum 等价物，数据包监控/协议分析）
       c. **无头阻断**：内存中阻断 UI/GPU/Renderer 进程降内存
       d. **模拟触发 `cpp_impl` 激活信号**（旧载具职责，自建宿主已不需要）
     - **业务层优先 NAPI（优先级而非禁令）**：收发消息/事件监听/数据解析**优先**走官方 NAPI 导出接口（稳定、简单、可维护）；仅当 NAPI 无法覆盖的能力（数据包层、环境模拟）才用 C++ 逆向补足。
     - **技术手段不设限**：允许 koffi / vtable 槽位 / 内存偏移 / thiscall 裸调等逆向手段——但**仅限 loader 的私有 native 组件**，业务层（kernel/adapter）仍不得直接使用（版本脆弱性，不是合规问题）。
     - **绝对禁止（许可证底线，不变）**：复制/移植 GPL-2.0-only 实现代码（与 MIT 不兼容），任何文件（含类型定义）不得来自此类项目。
   - **零磁盘篡改**：内存 Patch 仅在 QQ.exe 运行期 RAM 生效，**严禁修改/覆盖磁盘上 QQ 安装目录任何二进制**（QQNT.dll / wrapper.node / package.json / asar）；升级/卸载零残留。
   - **逆向产物管理**：Ghidra 分析（RVA 表/Offset）不提交公共仓库，仅存私有；旧 koffi 探测脚本已移除（历史实现查 git 历史）。
8. **全局配置 = 单一 TOML 文件**（2026-08-05 用户拍板；2026-08-07 移到项目根；2026-08-08 账号内嵌协议段）：所有配置统一放 `<项目根>/napuketto.toml`（全局段 + `[[accounts]]` 账号段——**协议与通信配置嵌在账号内**：`[accounts.onebot11]` / `[accounts.satori]`，账号没写某协议段 = 不启用该协议），**不再使用独立 JSON 配置文件**（JSON 门槛太高）。**账号必填**（至少一个，qq 必填，2026-08-08 拍板）。**数据根默认 `<项目根>/.napuketto`**（2026-08-08 拍板：部署原因不放用户目录；支持 `~`/相对路径，消费端 `resolveDataRoot` 展开），优先级 `--data-dir` > `NAPKETTO_DATA` > 项目根默认；配置文件路径解析见 kernel `resolveConfigPath`（`NAPKETTO_CONFIG` 显式 > 项目根探测 > 数据根兜底）。kernel `ConfigBase` 支持 TOML（smol-toml 解析/序列化，按 `.toml` 扩展名推断）+ `seed`（内存初值：boot 按登录账号 uin 从 accounts 取协议段 zod 校验后作 seed，adapter 不再读独立协议文件）。cli `config init/list/apply` 读写该文件；本机配置不入库（.gitignore，模板才入库）。**嵌入式内联形态（2026-10-25）**：`NAPKETTO_CONFIG_JSON` 环境变量可注入与 toml 同构的 JSON 配置（优先级高于 `NAPKETTO_CONFIG`，KuroBridge 等宿主每次拉起前整体生成，消除托管文件本体）；内联生效时零 toml 文件落盘（全链路不读/不写/不校验），配置校验失败一族（kernel `ConfigError`）以退出码 78 区分运行时崩溃（宿主免重启），文件形态下仍为单一 TOML。

## 工作流

```bash
pnpm install            # 安装依赖
pnpm check              # biome check + tsc --noEmit（提交前必跑）
pnpm fix                # biome 自动修复 + tsc
pnpm -r build           # 全量构建（tsdown）
pnpm --filter @napuketto/kernel dev   # 单包 watch 构建
pnpm changeset          # 随改动记录版本 bump（2026-08-07 引入 Changesets）
pnpm release:dryrun     # 本地演练：升版本 + 构建 + npm publish --dry-run（不发布）
```

**一切改动走 PR（2026-10-21 起）**：main 由 ruleset「保护主分支」保护（pull_request + 1 审批 + merge queue + 必需状态检查 + 签名 + CodeQL）。开发在分支上提交 → 开 PR → CI 三个 job（gate / windows / audit）全绿 → 合并（squash，走 merge queue）。**唯一允许直推 main 的是发布链的版本提交**（`.github/workflows/release.yml` 的 prepare job 用 GitHub App token 绕过 ruleset）；其余任何改动（含文档、CI）都走 PR，禁止人工直推。

**版本管理（Changesets，2026-08-07）**：多包 monorepo 统一用 changesets 联动版本。
- **changeset 工作流（强制，勿攒）**：每次完成一批用户可见改动（feat / fix / refactor 涉及发布内容），**必须随改动一起**在 `.changeset/` 写 changeset 并提交，不要攒到发版前——攒必漏，漏写则 `changeset version` 无 pending 条目直接退出，版本号与 CHANGELOG 不更新、无法发包。写法：`pnpm changeset` 交互式选择，或手写 `.changeset/<名字>.md`（frontmatter 声明受影响包 + bump 类型 + 简体中文说明，模板见下）。
- **bump 类型（0.x 阶段，API 未冻结）**：API 破坏 → minor（`0.1.x → 0.2.x`）、修复 → patch（`0.0.x`）；**依赖联动自动处理**：kernel 升版本 → 依赖它的 adapter/loader/cli 同步升 patch 并重依赖新版本。
- **不需要 changeset**：纯 chore——native 子模块指针、pnpm-lock 更新、删除脚本、文档、无行为变化的目录重命名。
- **发布（CI 自动，2026-10-21 起）**：日常发版 = 合并带 changeset 的 PR。`.github/workflows/release.yml` 先由 `prepare` 消费 changeset（`pnpm release:version` → 构建 → 测试）并推送版本提交，再由 `publish` 在 `release` environment 审批后走 **npm OIDC 可信发布**（无长期 token，自动 provenance）。重跑幂等：registry 比对自动跳过已发布版本；补发用 `workflow_dispatch` + `skip-version`。**发不出包时先检查 `.changeset/` 是否有 pending 条目**。完整流程（App / environment / npm 信任配置 / 两天过期规则）见 `docs/guides/release.md`。
- **本地发布只作应急/演练**：`pnpm release`（= `release:version` + `release:build` + `release:publish`）走本机 npm 登录态 + 2FA；正常发布不要用它。changeset version 后发布链已自动跑 `pnpm install --lockfile-only` 刷新 lock——依赖变更与 lock 必须同一 commit。
- **lockfile 一致性 pre-commit 钩子（2026-09-20 起，自动启用）**：根 prepare 设 `core.hooksPath tooling/git-hooks`；暂存 package.json / pnpm-workspace.yaml / native 子模块指针而未带 pnpm-lock.yaml 时，钩子自动跑 `pnpm install --lockfile-only --ignore-scripts` 校验，lock 出现 diff 即拒绝提交（根治 CI `ERR_PNPM_OUTDATED_LOCKFILE` 红灯，2026-09 三次同根因）。绕过用 `--no-verify`（不推荐）。
- ⚠️ 发布权限已交给 OIDC：npm 侧是**逐包**信任配置（repository / release.yml / environment=release），新建后 2 天内必须完成首次发布。本机不再需要长期 token；任何日志与文档都不得打印凭证。

  > `.changeset/<名字>.md` 模板：
  >
  > ```md
  > ---
  > "@napuketto/kernel": patch
  > ---
  >
  > fix(kernel): ……（简体中文说明）
  > ```
  >
  > 注：create-napukettoqq 对 `@napuketto/cli` 的依赖范围已重构为运行时自读自身 `package.json`（`cliVersionRange()`），发版无需手动同步常量。

## 代码风格（biome 已强制，手动也须遵守）

- 缩进 **space+4**，行尾 **LF**（Windows 下 CRLF 会被 biome 修复）。
- 类型安全：`strict` 全家桶、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`verbatimModuleSyntax`、`noUnusedLocals/Parameters` 均为 error。
- 类型导入一律 `import type`；禁止 `any`（例外必须注释说明原因）。
- `noFloatingPromises` 为 error：异步调用必须 `await` 或显式 `.catch`。
- 错误处理：业务错误抛类型化错误，不静默吞掉；日志统一走 pino。

## 实现模式（重要）

- **一个模块一个模块实现**：开工前先读 `docs/architecture/overview.md`、`docs/architecture/runtime.md` 与对应包的 `docs/design.md`，按其中的「实现顺序」推进，不跨模块跳跃；每完成一个模块跑一次 `pnpm check`。
- **类型层来自运行时探测**：`services/listeners/entities` 的类型通过加载 `wrapper.node` 后的运行时反射 + 实体 JSON 日志观察产出，不是拍脑袋或抄别家。探测代码在 `packages/kernel/src/wrapper/probe/`。
- **kernel 无全局单例**（ADR-015 推论）：logger / cache / event-channel 等都是实例化对象，由 `CoreContext` 持有——多账号多进程场景每进程一份，避免跨账号状态污染。
- **新增协议**（如 Satori / KuroBot）→ 在 `packages/adapter` 内新增协议目录，复用 core 框架（生命周期/订阅/广播/校验），**不改 network、不改 kernel**。
- **写代码前先更新对应包的 `docs/design.md`**，设计先行。

## 环境

- Node.js（ESM，`"type": "module"`）；TypeScript `NodeNext` 解析；包名统一 `@napuketto/*`。
