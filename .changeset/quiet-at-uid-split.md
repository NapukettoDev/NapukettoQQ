---
"@napuketto/kernel": patch
"@napuketto/adapter": patch
---

fix: 群聊 at 段目标不再被 QQNT 归零为 `"0"`（issue #192）

QQNT `TextElement` 的 at 目标分两个字段：`atNtUid` 是 `u_...` NT UID（QQNT 解析真实
提及依赖它），`atUid` 只是数字 UIN 的镜像（写入非数字会被 wrapper 归零成 `"0"`）。
发送方向单人 at 改为把目标写进 `atNtUid`（纯数字目标才写 `atUid`），`content` 统一归一
为带 `@` 前缀的显示文本，`@全体` 按原生形态发 `atType=1` + `atNtUid="all"`；接收方向
优先读 `atNtUid`，仅在缺失时回退到非空且非 `"0"` 的 `atUid`，两者都无效时降级为普通
文本，不再把 `"0"` 传给 uid→uin 转换（`getUinByUids` 的 `Data Not Existed!`）。
OB11 发送侧对 `u_...` 目标直通（不重复调 `uinToUid`），群聊 at 缺 `name` 时用群成员
缓存补群名片/昵称作 `display`。
