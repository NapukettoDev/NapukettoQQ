---
"@napuketto/cli": patch
---

优化 CLI 错误日志：预期内的配置/参数错误（`ConfigError`、`KernelError` 的 `INVALID_PARAM`）把 `err → cause` 消息链拼成单行提示，只带 `errorType`/`code` 轻量字段，默认级别不再打印冗长堆栈；完整堆栈降级到 debug 日志保留排障能力。退出码契约不变（`ConfigError` → 78，其余 → 1）。
