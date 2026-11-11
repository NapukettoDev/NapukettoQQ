---
"@napuketto/kernel": minor
---

feat(kernel): 新增 FlashTransferApi（闪传上传文件集 + 发分享卡片），点亮文件投递通道

文件消息路线被服务端传输命令拒（`170019002`，与业务参数无关），闪传是当前唯一实测可用的
「把文件送到对端」通道：上传文件集拿到 `fileSetId`，再发卡片消息。语义是分享链接卡片，
不是 `fileElement` 文件消息、也不进群文件列表（探测结论见 kernel design §15）。
