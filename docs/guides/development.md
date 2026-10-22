# 开发与工程化

## 1. 环境

- Node.js 24（与 CI 一致）。
- pnpm 12.4.1，由根 `package.json` 的 `packageManager` 锁定；用 corepack 或对应版本。
- TypeScript 7（原生编译器）、tsdown、biome、vitest。

`packages/loader/native` 是私有 submodule（闭源 stub 与逆向产物），不影响主仓构建与测试；
没有访问权限时跳过即可：

```bash
pnpm install
git submodule update --init --recursive   # 有权限时
```

## 2. 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm install` | 安装依赖；根 `prepare` 会配置 git hooks 并全量构建 |
| `pnpm check` | `biome check .` + `tsc --noEmit`，提交前必跑 |
| `pnpm fix` | biome 自动修复 + tsc |
| `pnpm test` | vitest 全量单测 |
| `pnpm test:coverage` | 覆盖率（等价 `vitest run --coverage`） |
| `pnpm -r build` | 全量 tsdown 构建 |
| `pnpm --filter @napuketto/kernel dev` | 单包 watch 构建 |
| `pnpm changeset` | 记录版本 bump |
| `pnpm release:dryrun` | 本地演练：升版本 + 构建 + `npm publish --dry-run` |

## 3. 构建顺序

全新环境或依赖变更后，先 `pnpm -r build`，再 `pnpm check` / `pnpm test`：

- `tsc` 按 NodeNext 解析 workspace 包，经 `package.json` 的 `exports` 读取 `dist` 里的类型
  声明；没有 `dist` 会直接 `TS2307`。
- `tooling/package-exports.test.ts` 断言 `dist` 里的 `.d.mts` / `.d.cts`，同样需要先构建。

CI 的顺序固定为 build → check → test；本地全绿而 CI 红时优先怀疑这个顺序。

## 4. 测试

- 测试与源码同目录（`*.test.ts`），由根 `vitest.config.ts` 统一发现。
- 单测不加载真实 `wrapper.node`：用 mock/fixture 覆盖协议翻译、配置、连接状态机、日志、
  文件系统边界。
- `tooling/package-exports.test.ts` 守护发布包的 `exports` 形状（双格式包的
  `import` / `require` / 顶层 `types` 条件）。
- CI 在 Ubuntu 与 Windows 各跑一套测试；平台相关逻辑用 `skipIf` 或纯函数注入平台参数。

## 5. CI 与 PR

**一切改动走 PR**。`main` 由 ruleset「保护主分支」保护：pull request + 1 审批 + merge queue +
必需状态检查 + 签名 + CodeQL。唯一允许直推 `main` 的是发布链的版本提交
（`.github/workflows/release.yml` 的 `prepare` 用 GitHub App token 绕过 ruleset）。

CI（`.github/workflows/ci.yml`）三个并行 job，job name 就是必需检查 context：

| job | 内容 |
|---|---|
| `gate (build / check / test / coverage)` | Ubuntu：build → check → test + Codecov 覆盖率 |
| `windows (test)` | Windows：同一套测试再验一个平台 |
| `audit (fallow 增量门禁)` | `fallow audit --base`，只报本次改动引入的死代码/复杂度/重复 |

`merge_group` 触发不可省：merge queue 只认在队列临时 ref 上跑出来的检查。改 job name 必须
同步改 ruleset，否则 PR 永远等不到同名检查。

## 6. Changesets

每个**用户可见**改动（feat / fix / refactor 涉及发布内容）都要随改动提交
`.changeset/<名字>.md`，不要攒到发版前：

- API 破坏 → `minor`（0.x 阶段：`0.1.x → 0.2.x`）。
- 修复 → `patch`。
- 依赖联动由 changesets 自动处理（kernel 升版本会带动 adapter/loader/cli）。
- 纯 chore 不需要：文档、lockfile、子模块指针、删除脚本、无行为变化的目录重命名。

模板：

```md
---
"@napuketto/kernel": patch
---

fix(kernel): ……（简体中文说明）
```

漏写 changeset 会导致 `changeset version` 无条目可消费、版本与 CHANGELOG 不更新。发布流程
见 [release.md](release.md)。

## 7. 代码风格

biome 已强制，手动也须遵守：

- 缩进 4 空格，行尾 LF。
- 类型安全：`strict` 全家桶、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、
  `verbatimModuleSyntax`、`noUnusedLocals/Parameters` 均为 error。
- 类型导入一律 `import type`；禁止裸 `any`（确需例外必须注释原因）。
- 异步调用必须 `await` 或显式 `.catch`（`noFloatingPromises`）。
- 业务错误抛类型化 `KernelError`，不静默吞掉；日志统一走 pino。
- kernel 无全局单例：logger/cache/event-channel 都由装配层实例化持有。

## 8. 实现方式

- **设计先行**：写代码前先更新对应包的 `docs/design.md`；新协议在 `packages/adapter`
  内新增目录，复用 core 框架，不改 network、不改 kernel。
- **一个模块一个模块推进**：按包设计书的实现顺序做，不跨模块跳跃；每完成一个模块跑一次
  `pnpm check`。
- **接口变更同步文档**：跨包契约、配置字段、协议面变化时，更新 `docs/` 对应文档；
  文档只描述机制与路径，不复制类型签名。
