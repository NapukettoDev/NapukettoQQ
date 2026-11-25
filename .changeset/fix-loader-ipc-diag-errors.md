---
"@napuketto/loader": patch
---

修复 IPC 诊断动作的三处既有问题（仅在显式启用 `NAPUKETTO_DIAG=1` /
`LaunchOptions.diagnostics` 时可见，默认动作表仍不含 `diag.*`）：

- `serviceOf` 先区分「session 未注入」与「getter 缺失」：session 缺失报
  「session 未注入」，已注入但缺 getter 报「session 已注入但缺少
  `getXxxService()`」，不再误报为 session 缺失。
- `diag.richMediaTmpPaths` 复用同一判定口径，逐服务输出「session 已注入但缺少
  `getXxxService()`」/「… 服务为 null」，不再用 `"null"` 模糊占位。
- `diag.sessionCall` / `diag.engineCall` 将 `null` 与 `undefined` 同按未注入处理，
  不再落入英文兜底；`validateDiagnosticCall` 的非对象目标文案改为
  「目标对象不可反射」，诊断层对外错误文案保持全中文。

`ALLOWED_METHODS` 白名单与诊断动作默认不注册的安全边界（H-01）均未改动。
