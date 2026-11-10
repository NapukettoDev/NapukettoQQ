---
"@napuketto/kernel": patch
"@napuketto/adapter": patch
---

fix: Linux 原生宿主入站字段收口（图片 `sourcePath`、`sender.nickname` 回退、milky 空值嗅探）

- kernel `picToCanonical`：Linux `picElement` 没有 `picPath`/`picUrl`，原图落在
  `sourcePath`（绝对路径）。路径取值改为 `picPath → picUrl → sourcePath`，空串
  视为缺失；`url` 仍只在 `picUrl` 非空时提供（`originImageUrl` 是无 host 的相对
  路径，不伪造 CDN 域名）。修复 Linux 入站图片段 `file` 恒为空。
- adapter OB11：Linux `sendNickName` 是空串、显示名在 `sendMemberName`。事件与
  `get_msg`/历史消息统一经 `senderNickname()` 回退（Windows 仍昵称优先）。
- adapter milky：元素存在性嗅探统一 `!= null`（grayTip / 多转发 / 撤回 /
  fileElement / aioOp），避免 Linux 显式 `null` 变体被误判。
