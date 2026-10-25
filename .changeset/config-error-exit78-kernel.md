---
"@napuketto/kernel": minor
---

feat(kernel): 配置校验失败错误类型 ConfigError 与退出码契约（嵌入式宿主）。新增 `ConfigError extends KernelError`（code 恒 INVALID_PARAM，协议层错误码映射零涟漪），`ConfigBase` 的反序列化/校验失败改抛该类型（文案不变）；新增 `ConfigBase.parseText(raw)` 只读校验（config validate 用，不落模板）与 `EXIT_CONFIG_INVALID = 78` 导出。配置未就绪一族从此与运行时崩溃在类型层面可区分，宿主据此免重启。
