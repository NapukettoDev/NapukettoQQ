---
"@napuketto/loader": patch
"@napuketto/adapter": patch
---

内部路径脱敏重命名（零行为变更、零对外 API 变化）：

- loader 产物链目录 `src/qq/` → `src/artifacts/`，版本清单形状模块
  `manifests/qq-releases.ts` → `manifests/releases.ts`；包根清单
  `qq-releases.json` → `releases.json`（`files` 白名单同步）。
- CI 更新脚本与 workflow 更名：`tooling/qq-releases/` → `tooling/releases/`、
  `update-qq-releases.yml` → `update-releases.yml`（日志前缀与分支名同步）。
- adapter 包内私有目录 `src/internal/qq/` → `src/internal/domain/`，与
  `internal/infra/` 形成 `domain / infra` 对仗。

导出的符号、类型、`@deprecated` 别名与 `package.json#exports` 均保持不变。
