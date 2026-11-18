---
"@napuketto/adapter": patch
---

按可见性轴重整包内分层：`src/core/` → `src/framework/`（公开契约层，仍以子路径 `@napuketto/adapter/core` 导出），`src/shared/` → `src/internal/{qq,infra}/`（包内私有，无 barrel）。

- `framework/` 与 `internal/` 物理隔离公开 SDK 与私有实现；`dist/core/index.mjs` 产物路径不变（tsdown 对象 entry 映射），loader 与外部消费方零改动
- 边界由 biome `noRestrictedImports` 强制：`framework/**` 不得 import `internal/**`
- 嵌入式 DX 契约测试从 `src/__tests__/` 迁至 `tooling/embedded-dx.test.ts`：它断言 dist 产物、与 `package-exports.test.ts` 同属产物契约测试，不再按「包内模块单测」口径被误读（本地跑测试前须 `pnpm -r build`）
- 纯内部重构，导出符号与子路径集合不变
