---
"@napuketto/adapter": patch
---

按可见性轴重整包内分层：`src/core/` → `src/framework/`（公开契约层，仍以子路径 `@napuketto/adapter/core` 导出），`src/shared/` → `src/internal/{qq,infra}/`（包内私有，无 barrel）。

- `framework/` 与 `internal/` 物理隔离公开 SDK 与私有实现；`dist/core/index.mjs` 产物路径不变（tsdown 对象 entry 映射），loader 与外部消费方零改动
- 边界由 biome `noRestrictedImports` 强制：`framework/**` 不得 import `internal/**`
- 纯内部重构，导出符号与子路径集合不变
