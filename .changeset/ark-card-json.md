---
"@napuketto/kernel": patch
---

fix(kernel): 接收方向识别 ARK 卡片（小程序/分享卡片）为 canonical json——此前落 unknown 兜底，OB11 侧整段静默丢弃（纯卡片消息 message 数组为空）、koishi 侧渲染 [unknown] 占位；bytesData JSON 字符串原样透传
