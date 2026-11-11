# 开发与工程化

> 面向贡献者：本页讲本地怎么装、怎么跑、怎么过门禁。「必须遵守什么」（依赖方向、
> 许可证、原生交互边界等红线）见 [AGENTS.md](../../AGENTS.md)，两页不重复。

## 环境

- Node.js 24（CI 口径；根 `engines` 为 `>=22.12.0`），pnpm 12.4.1 由根 `package.json` 的
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
| `pnpm check` | biome + tsc + 文档检查，提交前必跑 |
| `pnpm fix` | biome 修复 + tsc + 文档检查 |
| `pnpm test` | vitest 全量单测 |
| `pnpm test:coverage` | `vitest run --coverage` |
| `pnpm -r build` | 全量 tsdown 构建 |
| `pnpm changeset` | 记录版本 bump |
| `pnpm release:dryrun` | 升版本 + 构建 + dry-run 发布 |

单包 watch 构建：`pnpm --filter @napuketto/kernel dev`。

`pnpm check` 的文档检查（`check:docs`）扫描受治理的文档集：日期/阶段词、手工标题编号、
死链、行数与行宽。文档格式约束见 [docs/README.md](../../docs/README.md) 的写作规范。

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
  Node ≥22.12 的 `require(esm)` 加载）、`engines.node`、库包的 `sideEffects: false`、
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
