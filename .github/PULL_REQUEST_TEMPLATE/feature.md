# PR 说明（新特性 / 功能增强）

> 标题 `feat(<包>): ……`；写清接口变化与依赖方向，破坏性变更点名迁移方式。空章节写「无」。

## 1. 做什么 / 为什么

<!-- 目标场景与动机：解决谁的什么问题。设计先行：写代码前先更新对应包的 docs/design.md，此处引用它。 -->

## 2. 对外接口

<!-- 新增 / 变更的配置项（napuketto.toml 的哪个段）、协议面、CLI 命令或事件；破坏性变更单独点名并给迁移方式。 -->

- 新增：
- 变更：
- 破坏性变更：无

## 3. 实现要点

<!-- 关键设计决策与被否掉的替代方案；跨包改动列出涉及包名。
     红线复核：依赖方向必须单向（kernel / network / media ← adapter ← loader / apps），
     新协议只能在 packages/adapter 内新增目录并复用 core 框架，不得改 network 或 kernel。 -->

## 4. 验证

- [ ] 新增用例：文件与用例名（覆盖主路径 + 边界）
- [ ] `pnpm check` 全绿（biome + tsc）
- [ ] `pnpm test` 全绿
- [ ] `pnpm -r build` 通过
- [ ] `pnpm exec fallow audit --base origin/main` 无新增问题
- [ ] 新协议 / 新事件面在 `docs/protocols/` 或包 `docs/design.md` 有对应说明，且配置文档同步

## 5. changeset

<!-- 新能力 → minor；兼容性扩展 → patch；破坏性变更 → minor（0.x 阶段，根 AGENTS.md「版本记录」）。不面向发布的私有包 → 「无」。 -->

- minor

## 6. 影响面与风险

<!-- 依赖方向是否仍单向、是否引入新的外部依赖、性能与体积影响、协议兼容性、回滚方式。 -->

## 7. 关联

<!-- 相关 issue / 讨论 / 协议规范链接；无则写「无」。 -->
