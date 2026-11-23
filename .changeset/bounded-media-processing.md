---
"@napuketto/media": minor
"@napuketto/adapter": minor
"@napuketto/kernel": patch
---

限制媒体探测、SILK、视频转码和 Milky Base64 媒体的输入与产物，支持通过 AbortSignal
取消音视频处理，等待后台工作退出并清理临时文件。视频转码产出分片 H.264/AAC MP4，
缩放宽高接受 2–4096 的偶整数，帧率接受 1–60。Milky Base64 接受标准和 URL-safe
载荷及省略填充，载荷中的空白和无效字符会被拒绝。富媒体 MD5 改为分块读取。
