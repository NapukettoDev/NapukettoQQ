# 贡献指南（CONTRIBUTING）

感谢关注 NapukettoQQ（基于 QQ NT 客户端原生模块 `wrapper.node` 的机器人框架，对外提供 OneBot 11 / Satori，并提供 KuroBot 群服互通，MIT 全自研）。

## 快速上手

1. 环境要求：Node.js ≥ 24（与 CI 一致）、pnpm 12.4.1（版本由根 package.json 的 `packageManager` 字段锁定，corepack 依此选版本）。
2. `pnpm install` 安装依赖；`packages/loader/native` 为私有子模块（闭源 stub，仅分发编译产物），无访问权限不影响主仓构建与测试，可跳过。koishi 适配器自 2026-10-18 起是独立仓库，不在本 workspace 内。
3. 开工前先读工程指南：[AGENTS.md](../AGENTS.md)（硬性约束 / 依赖方向 / 工作流）→ [docs/README.md](../docs/README.md)（文档导航）→ [docs/architecture/overview.md](../docs/architecture/overview.md)（架构总览）→ [docs/architecture/runtime.md](../docs/architecture/runtime.md)（运行链路）→ 对应包的 `docs/design.md`。

## 提交前检查

```bash
pnpm check    # biome check + tsc --noEmit，全绿再提交
pnpm test     # vitest 全量单测
```

涉及发布的包改动时加跑 `pnpm build`。

以上检查由 CI 自动执行（[workflows/ci.yml](./workflows/ci.yml)）：PR、main push 与 merge queue（`merge_group`）触发三个并行 job——`gate`（build / check / test / 覆盖率上报 Codecov）、`windows`（跨平台测试补位）、`audit`（fallow 增量审计，配置见根目录 `.fallowrc.jsonc`）。本地全绿而 CI 红，优先排查构建顺序：CI 里 build 前置于 check 与 test（类型检查读取各包 dist 里的类型声明，`package-exports` 守卫也断言 dist 产物）。

## PR 流程（强制）

**一切改动走 PR，禁止直推 main**（唯一例外是发布链自动生成的版本提交，见「发布」）。main 的 ruleset 开了 pull_request + merge queue + 必需状态检查：

1. 从 main 切分支（如 `feat/kurobot-xxx`、`fix/loader-xxx`）提交；
2. 开 PR，说明改了什么与为什么；CI 三个 job 全绿（`gate` / `windows` / `audit`）后才合并；
3. 合并走 squash（merge queue 统一压成一个签名提交），不要本地 merge main 后再推。

## 发布

日常发版不需要本地操作：带 changeset 的 PR 合并后，[workflows/release.yml](./workflows/release.yml) 自动消费 changeset、构建、测试并推送版本提交，随后在 `release` environment 审批后走 npm OIDC 可信发布。**不要手动 `npm publish`**；补发用 Actions 的 `workflow_dispatch`（`skip-version`）。完整设置与排障见 [docs/guides/release.md](../docs/guides/release.md)。

## 提交约定

- 提交信息用简体中文，格式 `type(scope): 描述`，`type` 参考 `feat` / `fix` / `docs` / `test` / `refactor` / `chore`，可带 scope（如 `fix(adapter):`）。
- 面向发布的包改动**必须随提交写 changeset**（`pnpm changeset` 或手写 `.changeset/*.md`），勿攒到发版前；纯 chore（文档、lockfile、子模块指针）不需要。发版由 CI 发布链统一消费（见「发布」）。
- 设计先行：新功能先更新对应包的 `docs/design.md`，再按「一个模块一个模块」推进，每完成一个模块跑一次 `pnpm check`。

## 许可证红线

- 本仓 MIT，**零引入 NapCat 代码**（NapCat 为 GPL-2.0-only，与 MIT 不兼容）：任何文件（含类型定义）不得复制或移植自 NapCat。
- `packages/loader/native/` 的逆向产物（RVA / Offset 表等）绝不进本仓库。

## 行为准则与安全

- 参与本项目即同意遵守[行为准则](./CODE_OF_CONDUCT.md)。
- 漏洞请勿开公开 issue，按[安全政策](./SECURITY.md)私下报告。
