---
"@napuketto/kernel": minor
"@napuketto/adapter": minor
"@napuketto/loader": minor
"@napuketto/network": minor
"@napuketto/media": patch
---

嵌入式 SDK 体验（DX）收口：补齐 Public API 导出与 `ProtocolConfig` 兼容导出，新增 `createKernelRuntime` 服务聚合与 `NapukettoCore.activateSession/createRuntime`，支持 Plain Object 协议配置与可选 `broadcaster`，并修复定时器/原生监听器泄漏、异步监听异常逃逸与幂等 `dispose()` 生命周期。
