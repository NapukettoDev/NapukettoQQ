---
"@napuketto/kernel": minor
"@napuketto/media": patch
---

feat(kernel): 支持视频消息发送（VIDEO 元素）

- canonical `video` 元素扩展 `thumbPath` / `width` / `height` / `durationSec`，收向
  `videoToCanonical` 同步补全（`thumbWidth`/`thumbHeight`/`fileTime`/`Map` thumbPath）。
- 新增 `MsgApi.prepareVideoElement`：md5 → `getRichMediaFilePathForGuild`
  （`downloadType=1` 原文件 / `2` 缩略图）→ `util.copyFile` 放置 → 完整
  `videoElement`（`thumbPath` 为真实 `Map<0, path>`，JSON 边界会丢成 `{}`）。
- **修复关键坑**：缩略图目标路径必须用**视频 md5**（`Thumb/<videoMd5>_0.png`），
  `thumbMd5` 只是缩略图内容 md5；用 thumbMd5 算路径会让 native 传输找不到缩略图，
  报 `rich media transfer failed`。
- `placeMediaFile` 增加 `downloadType` 参数（PIC/PTT 行为不变）。
- `toSendElements` 的 `video` 分支改为显式报错「需经预处理」，防止绕过。
- 自建宿主实测（2026-10-17）：`sendMsg` 成功（sendStatus 2/3），群内收到可播放视频；
  详见 `packages/kernel/docs/design.md` §8。

feat(media): 新增 `extractVideoFrame`（ffmpeg 抽首帧 PNG 作视频缩略图）
