---
"@napuketto/loader": patch
---

内部目录结构与模块拆分重构（行为零变更、对外 API 零变更）：`type-guards` / 文件日志下沉
`internal/`，host 类型层拆为 `constants` / `protocol-types` / `service-types`（`types.ts` 成纯类型），
`host/ipc/` 移除 barrel 并去掉冗余 `ipc-` 前缀，`qq/` `boot/` `host/core` 按职责拆出
`install-probe` / `seven-zip` / `env-keys` / `module-loader` / `optional-protocols` /
`session` / `bootstrap-probe` / `at-resolver` 等子模块，并补齐对应单测与依赖方向守卫。
