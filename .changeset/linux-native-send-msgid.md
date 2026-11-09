---
"@napuketto/kernel": patch
---

fix(kernel): sendMessage 返回确认事件里的真实 msgId

Linux 原生宿主实测：`sendMsg` 前自己生成的 msgId 只落在确认事件（`onMsgInfoListUpdate`）
的 `guildId` 字段上，wrapper 落库的消息是另一个 msgId。导致 adapter 用生成 id 分配的
OneBot `message_id` 拿去 `get_msg` / `delete_msg` 查不到（发送本身是成功的）。
现在 `confirmSend` 交回命中的那条消息，`sendMessage` 优先返回它的 `msgId`，缺失才回退
生成值；Windows 侧两者相同，行为不变。
