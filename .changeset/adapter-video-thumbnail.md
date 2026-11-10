---
"@napuketto/adapter": minor
---

feat(adapter): OneBot 11 发送视频时自动补首帧缩略图与时长/尺寸

QQ 视频消息要求 `thumbMd5 / thumbSize / thumbPath(Map) / thumbWidth / thumbHeight`
与秒级 `fileTime` 成套出现；kernel 只在 canonical 带 `thumbPath` 时才写这套字段，
所以「只给 `file` 的 `video` 段」在 native 侧必然失败，且只回 `sendStatus=0`
（没有错误信息，2026-11-10 Linux 原生宿主实测）。

adapter 现在在发送前归一化（`core/shared/media.ts` 的 `prepareVideoElements`）：
用 `@napuketto/media` 的 `getVideoInfo`（ffprobe）取宽高与时长、`extractVideoFrame`
（ffmpeg）抽首帧写系统临时目录，补 `thumbPath / width / height / durationSec`，
发送结束清理临时目录；抽帧失败抛可读 `MediaError`，不再让 native 静默回
`sendStatus=0`。

代价：OB11 发视频从此要求系统有 `ffmpeg` / `ffprobe`（与 satori 的 `transcodeVideo`
同一前提）。Linux 原生宿主实测：1s 64×64 H.264 mp4 发送 `retcode 0`、缩略图按视频
md5 落盘、撤回通过。satori / milky / kurobot 的发送路径暂未接入本函数。
