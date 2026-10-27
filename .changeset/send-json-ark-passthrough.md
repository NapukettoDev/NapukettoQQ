---
"@napuketto/kernel": minor
---

feat(kernel): 发送方向 canonical json 元素透传 ARK——`toSendElements` 加 `case "json"` → `{ elementType: ARK(10), arkElement: { bytesData } }`，与接收方向 ARK 识别（#18）对称：canonical json.raw 为字符串时原样透传（OB11 `send_msg` json 段 / satori 发送链给的已是卡片 JSON 文本），其余值 JSON 序列化（循环引用抛 KernelError INVALID_PARAM）。`SendMessageElement` 补 `arkElement?: { bytesData: string }`（字段名与接收侧 RawElement 同源，2026-10-25 真实消息实测）。OB11 json 段发送链路由此打通（此前 kernel 层直接抛"暂不支持"）；`xml`/`file`/`forward` 仍不支持
