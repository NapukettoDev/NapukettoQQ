---
"@napuketto/adapter": patch
"@napuketto/kernel": patch
---

修复启动 / 重连时把历史消息与旧好友申请当实时数据上报（issue #122）。

消息侧：登录 / 重连时 QQNT 会把离线与历史消息全量同步进 `Msg/onRecvMsg`，
此前直接上报，下游会误回复几天甚至几周前的消息。现在统一在
`shared/raw-message.ts` 的 `subscribeRawMessages` 里按订阅时刻（−5s 容差）过滤，
四个协议共用同一入口（satori / kurobot 此前连共享封装都没走，本次一并切换）。
`msgTime` 缺失或非法时放行，宁可多报不错杀。

好友申请侧：`Buddy/onBuddyReqChange` 在登录 / 重连 / 审批后会整批重放历史申请，
而收链路没有任何过滤——下游开启自动同意会陷入「全量重放 → 自动同意 → 触发回调 →
再次全量重放」的死循环。现在只推实时待处理项：

- 过滤 `isInitiator=true`（自己发起）、`isUnread=false`（已读）、`unreadNums=0`、
  `isDecide=true`（reqType 13 `KMEINITIATORWAITPEERCONFIRM` 除外）与
  `reqTime` 早于启动基准的历史积压；批级 `unreadNums=0` 整批短路。
- 剩余项按 `${friendUid}:${reqTime}` 做实例级去重（上限 512 条，跨
  `reloadTransports` 保留）。
- `comment` 改取 QQNT 实际字段 `extWords`（空则回退 `words`）——此前恒为空串。
- 陌生人 `user_id` 不再恒为 0：群成员口径（`GroupApi.uidToUin`）查不到时回退
  kernel 新增的 `ProfileApi.getUinByUid`（`getUserDetailInfo` 反查 `detail.uin`，
  fail-soft，单批上限 10 次），OB11 与 Milky 两侧共用。

字段判定一律「存在且明确」才生效：这些原生字段名仍是说明书参考，缺字段时放行而不是
静默丢申请。
