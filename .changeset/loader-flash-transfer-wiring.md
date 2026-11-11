---
"@napuketto/loader": patch
---

feat(loader): 装配 kernel `FlashTransferApi` 并透传到 OB11 / milky / IPC 桥

文件投递动作（`upload_group_file` / `upload_private_file`）需要闪传通道，loader 在
`createKernelServices` 构造 `flashTransferApi`，`assemble-protocols` 与 `ipc-ob11`
透传进 `OneBotApiOptions` / `MilkyApiOptions`（richMediaApi 同款）。
