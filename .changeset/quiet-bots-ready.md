---
"@napuketto/loader": patch
---

修复 Koishi IPC 初次引导和软重登时事件早于 `ready` 转发的问题，确保动作表装配完成且写出 `ready` 后才发送事件。装配失败时回滚已建立的 IPC 订阅及动作。
