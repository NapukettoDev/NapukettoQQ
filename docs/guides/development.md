# 开发与工程化

> 面向贡献者：本页讲本地怎么装、怎么跑、怎么过门禁。「必须遵守什么」（依赖方向、
> 许可证、原生交互边界等红线）见 [AGENTS.md](../../AGENTS.md)，两页不重复。

## 环境

- Node.js 24.11.0 或更高版本，pnpm 12.4.1 由根 `package.json` 的
  `packageManager` 锁定，用 corepack 或对应版本。
- TypeScript 7（原生编译器）、tsdown、biome、vitest；版本由 `pnpm-workspace.yaml` 的
  catalog 统一。

`packages/loader/native` 是私有 submodule（闭源 stub 与逆向产物），不影响主仓构建与
测试；没有访问权限时跳过：

```bash
pnpm install
git submodule update --init --recursive   # 有权限时
```

## 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm install` | 装依赖；`prepare` 配 hooks 并构建 |
| `pnpm check` | biome + tsc，提交前必跑 |
| `pnpm fix` | biome 修复 + tsc |
| `pnpm test` | vitest 全量单测 |
| `pnpm test:coverage` | `vitest run --coverage` |
| `pnpm -r build` | 全量 tsdown 构建 |
| `pnpm sandbox` | 初始化外部调试沙箱，显示配置位置 |
| `pnpm dev` / `pnpm start` | 在同一个外部沙箱前台启动仓库 CLI |
| `pnpm run config validate` | 校验沙箱内的配置 |
| `pnpm changeset` | 记录版本 bump |
| `pnpm release:dryrun` | 升版本 + 构建 + dry-run 发布 |

单包 watch 构建：`pnpm --filter @napuketto/kernel dev`。

## 外部调试沙箱

```bash
pnpm --filter "@napuketto/cli..." build
pnpm sandbox
pnpm run config validate
pnpm dev
```

`pnpm sandbox` 会提示 `napuketto.toml` 的位置。先填入调试账号，再校验并启动。
默认目录是仓库同级的 `Debug/napuketto-sandbox`，可用 `NAPUKETTO_SANDBOX_DIR`
覆盖。相对设置值以仓库根为基准。PowerShell 当前会话可用
`$env:NAPUKETTO_SANDBOX_DIR = '../Debug/napuketto-sandbox'` 设置。

数据、日志、缓存和原生 QQ 数据都放在外部目录。CLI 参数中的相对路径以沙箱为基准，
例如从其他地方读取配置时，给 `pnpm run config apply` 或 `pnpm run config validate --config`
传绝对路径。CLI 会拒绝越界的写入路径。调试入口加载当前 `dist`，修改源代码后先重新构建。

用 `pnpm dev status` 查询实例，`pnpm dev stop` 停止实例。需要重置时，先停止实例，再删除
含 `.napuketto-sandbox.json` 标记的沙箱目录。不同 checkout 并行使用时，各自指定独立目录。

## 构建顺序

全新环境或依赖变更后，先 `pnpm -r build`，再 `pnpm check` / `pnpm test`：

- `tsc` 按 NodeNext 解析 workspace 包，经 `package.json` 的 `exports` 读 `dist` 里的
  类型声明；没有 `dist` 会直接 `TS2307`。
- `tooling/package-exports.test.ts` 断言 `dist` 里的 `.d.mts` / `.mjs`，同样需要先构建。

CI 顺序固定为 build → check → test；本地全绿而 CI 红时优先怀疑这个顺序。

## 测试

- 测试与源码同目录（`*.test.ts`），根 `vitest.config.ts` 统一发现 `packages/*/src`、
  `apps/*/src` 与 `tooling/**`。
- 单测不加载真实 `wrapper.node`：用 mock/fixture 覆盖协议翻译、配置、连接状态机、日志、
  文件系统边界；平台相关逻辑用 `skipIf` 或纯函数注入平台参数。
- `tooling/package-exports.test.ts` 守护发布包的 `exports` 形状与发布元数据：全仓
  Pure ESM（只有 `types` + `default` 两个条件，子路径同样带 `default`，CJS 由
  Node.js 的 `require(esm)` 加载）、`engines.node`、库包的 `sideEffects: false`、
  `publishConfig.access: public` / `provenance: true`、`files` 白名单；另外三条回退
  门禁：catalog 内的依赖必须写 `catalog:`（防版本再分叉）、`packages/media/dist`
  小于 50 KB（防 tsdown 又把第三方库内联回产物）。
- `pnpm-workspace.yaml` 开了 `engineStrict: true`：Node 版本不满足 `engines` 时
  `pnpm install` 直接 `ERR_PNPM_UNSUPPORTED_ENGINE`（默认只警告）。

## CI 与 PR

改动走 PR，`main` 由 ruleset 保护（PR + 1 审批 + merge queue + 必需检查 + 签名 +
CodeQL）；唯一允许直推的是发布链的版本提交（`prepare` 用 GitHub App token）。
`.github/workflows/ci.yml` 三个并行 job，job name 就是必需检查 context：

- `gate (build / check / test / coverage)`：Ubuntu，install → 依赖审计 → build → check →
  test（lcov 覆盖率上传 Codecov）。
- `windows (test)`：Windows，同一套单测再验一个平台，不重复 check 与覆盖率。
- `audit (fallow 增量门禁)`：`fallow audit --base`，只报本次改动引入的死代码 / 复杂度 /
  重复，存量自动基线豁免。

`merge_group` 触发不可省：merge queue 只认在队列临时 ref 上跑出来的检查。改 job name
必须同步改 ruleset，否则 PR 永远等不到同名检查。

### PR 模板

PR 模板在 `.github/PULL_REQUEST_TEMPLATE/`，按领域拆。它们**不会自动带入** PR 正文，需要显式指定：
网页端 compare URL 加 `?template=<文件名>`，CLI 用 `gh pr create --template <文件名>`（传文件名，
不是模板标题）。没有默认模板——不指定时正文为空，跨领域或一次性改动自己按「改了什么 / 验证证据 /
影响面与风险 / 关联」写清楚。

| 模板 | 文件 | 什么时候用 |
|---|---|---|
| 修复 | `bug_fix.md` | 缺陷修复：现象与复现 → 根因 → 修法 → 回归用例 |
| 特性 | `feature.md` | 新能力或功能增强：接口变化 → 依赖方向 → changeset |
| 文档 | `docs.md` | 文档与手册改动：改动清单 → 依据 → 引用核对 |
| 依赖 | `dependencies.md` | 依赖升版 / 新增 / 移除、catalog 调整 |
| 重构与性能 | `refactor_perf.md` | 行为零变化的结构调整，或行为等价的性能优化 |
| 发布 | `release.md` | 发布链、changesets 配置与包发布面字段 |

模板只负责问全该领域必须交代的信息，通用要求（验证证据、changeset、空章节写「无」）各模板里独立写全。
增删或改名模板时同步本表。

## Changesets

每个**用户可见**改动（feat / fix / refactor 涉发布内容）随改动提交
`.changeset/<名字>.md`，不要攒到发版前：

- API 破坏 → `minor`（0.x：`0.1.x → 0.2.x`）；修复 → `patch`。
- 依赖联动由 changesets 自动处理（kernel 升版本会带动 adapter / loader / cli）。
- 纯 chore 不需要：文档、lockfile、子模块指针、删脚本、无行为变化的改名。

模板：

```md
---
"@napuketto/kernel": patch
---

fix(kernel): ……（简体中文说明）
```

漏写会导致 `changeset version` 无条目可消费、版本与 CHANGELOG 不更新。

## 代码风格

biome 已强制，手动也须遵守：

- 缩进 4 空格，行尾 LF；类型导入一律 `import type`。
- `strict` 全家桶、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、
  `verbatimModuleSyntax`、`noUnusedLocals/Parameters` 均为 error。
- 禁止裸 `any`（确需例外必须注释原因）；异步调用必须 `await` 或显式 `.catch`。
- 业务错误抛类型化错误（kernel 用 `KernelError`），不静默吞；日志统一走 pino。
- kernel 无全局单例：logger / cache / event-channel 由装配层实例化持有。

## 实现方式

- **设计先行**：写代码前先更新对应包的 `docs/design.md`；改跨包契约同步
  `docs/architecture/`。
- **一个模块一个模块推进**：按包设计书的实现顺序做，不跨模块跳跃；每完成一个模块跑一次
  `pnpm check`。
- **新协议**：在 `packages/adapter` 内新增目录，复用 core 框架，不改 network、不改 kernel。
- **接口变更同步文档**：配置字段、协议面变化时更新 `docs/` 对应文档；文档只描述机制与
  路径，不复制类型签名。
