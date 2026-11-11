# 贡献指南

> 本页只做跳板。完整开发环境、构建顺序、测试、PR 与 CI 说明见
> [docs/guides/development.md](../docs/guides/development.md)。

## 开始之前

1. 读 [AGENTS.md](../AGENTS.md)（红线/依赖/流程）与 [docs/README.md](../docs/README.md)（路由）。
2. 装 Node.js 24 与 pnpm 12（根 `package.json` 的 `packageManager` 已锁定版本），
   执行 `pnpm install`；`packages/loader/native` 是私有 submodule，无权限可跳过。

## 提交前

```bash
pnpm check    # biome + tsc + check:docs
pnpm test     # vitest 全量
```

涉及发布包的改动加跑 `pnpm -r build`，并随提交写 `.changeset/<名字>.md`。

## PR

一切改动走 PR（分支 → PR → CI `gate` / `windows` / `audit` 全绿 → squash 合并），
禁止直推 `main`；发布链的版本提交是唯一例外。提交信息用
`type(scope): 描述`（`feat` / `fix` / `docs` / `test` / `refactor` / `chore`）。

## 许可证

MIT，零引入 GPL-2.0-only 实现代码；`packages/loader/native` 的 RVA/Offset 绝不进本仓库。
参与即同意 [行为准则](./CODE_OF_CONDUCT.md)；漏洞按 [安全政策](./SECURITY.md) 私下报告。
