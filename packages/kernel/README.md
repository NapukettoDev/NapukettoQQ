# @napuketto/kernel

Napuketto 核心运行时内核——**全仓唯一原生交互层**。

直接 `process.dlopen` 加载 `wrapper.node`，把 QQ NT 内部 C++ 服务封装成语义化 API：

- **加载与引导**：wrapper 探测、版本解析、session 激活（`initAndStartSession` / `waitSessionReady`）
- **登录**：快速登录（历史账号）/ 二维码扫码，含网络重试
- **业务 API**：消息 / 群 / 群通知 / 好友 / 票据 / 富媒体 / 资料 / 资料卡点赞 / Web API
- **事件通道**：类型化事件总线（`NTEventChannel`）
- **缓存**：群资料只读缓存（`GroupCache`）
- **基础设施**：类型化错误（`KernelError`）、路径装配、pino 日志、TOML 配置（`ConfigBase`）

## 约束

- 全仓唯一允许触碰 `wrapper.node` / 注册原生 listener 的包
- 无全局单例——logger / cache / event-channel 等实例均由 `CoreContext` 持有，多账号每进程一份
