---
"@napuketto/adapter": minor
---

feat(adapter): `upload_group_file` / `upload_private_file` 改走闪传（文件投递可用）

文件消息路线被服务端传输命令拒（`170019002`，逐维扫参无效），改走 kernel `FlashTransferApi`：
上传文件集 + 发分享卡片。OB11 新增同名两动作（81 个动作），milky 两动作改道。

语义降级（已在协议文档明示）：发出的是「分享链接卡片」，不是文件消息、也不进群文件列表；
返回的 `file_id` 是闪传文件集 id，不能用于群文件动作。原 `sendFileMessage`（缺 `fileUuid` 时
把 msgId 当 file_id 返回的静默假成功）已删除。
