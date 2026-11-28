---
"@napuketto/kernel": patch
"@napuketto/loader": minor
---

自建宿主通过 kernel 的 prepareSelfHost 加载原生模块、激活 O3 分发并获取会话服务。部署时同步更新 kernel 与 loader，并将 NAPUKETTO_KERNEL_ENTRY 指向包含 prepareSelfHost 的 kernel 构建产物。O3 能力缺失会在原生引导阶段报告 INVALID_STATE 并退出。
