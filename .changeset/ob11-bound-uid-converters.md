---
"@napuketto/adapter": patch
---

OB11 `uinToUid` / `uidToUin` 便捷方法改为绑定实例的类字段（issue #110 侧报）：此前动作把
方法裸传为回调（resolveUid 等），脱绑调用 `this` 为 undefined，get_friend_msg_history /
set_input_status / mark_msg_as_read（含别名）/ send_private_forward_msg / set_friend_remark /
delete_friend / send_like 抛 `Cannot read properties of undefined (reading 'groupApi')`。
