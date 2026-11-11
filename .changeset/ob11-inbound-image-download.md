---
"@napuketto/kernel": minor
"@napuketto/adapter": patch
---

fix(adapter)/feat(kernel): 入站图片按需下载，修复 OB11 上报不存在的本地路径（issue #105）

自建宿主没有 UI，QQ NT 收到图片只给 `sourcePath` 目标路径、原图不落盘；`originImageUrl`
是无 host 的相对路径，补 CDN 域名后缺 rkey（实测回 `invalid rkey`），不能当直链。下游按
`data.file` 读图会抛 `FileNotFoundError`。

- kernel：新增 `MsgApi.downloadImage`（`downloadRichMedia` downloadType=1 原文件 + 轮询
  重拉元素直到 `sourcePath`/`picPath` 在磁盘真实存在；已存在直接返回，超时抛 `TIMEOUT`），
  `PicElement` 补齐 `originImageUrl` 与 `thumbPath` 实测形状。
- adapter OB11：事件翻译前对本地缺失的 PIC 元素并发补下载（限时 5s、失败 fail-soft 只
  warn 并保留原路径），把真实路径回填 `sourcePath` 后再上报；`get_image` 在无 `picUrl`
  时复用同一 API 兜底，不再返回空 `file`。
