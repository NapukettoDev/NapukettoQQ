---
"@napuketto/loader": minor
---

统一 self-host 信号、IPC 断管、进程控制和引导失败的限时关停，修复账号锁并发取得与误释放。IPC v1 的 ready 快照新增同代认证身份，早期和重装配期间查询返回 INVALID_STATE。stdin 限制单行 16 MiB 与 256 个在途动作。自建宿主要求 kernel 提供 dlopenWrapper（自 0.12.3 起提供）。升级同一账号目录前先停止旧宿主。
