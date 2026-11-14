---
"@napuketto/kernel": minor
---

入站图片本地路径防御（issue #105）：`toCanonicalElements` 的 image 路径改为存在性裁决——
候选链（picPath → sourcePath）取第一个真实存在的本地路径，全部缺失时回退 picUrl（URL 供
下游下载），仍无则置空；协议层不再收到不存在的本地路径（下游直接 stat 的消费者不再
FileNotFoundError）。配套：MsgBridge 对 `Msg/onRecvMsg` / `Msg/onMsgInfoListUpdate` 增加
有界落盘宽限等待（pic 本地路径全缺失时最多等 2s，任一存在即发射；快速路径零开销）。
