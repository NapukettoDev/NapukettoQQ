---
"@napuketto/adapter": patch
---

收链路共享原语收敛：`shared/uid-uin` 新增 `collectGroupNotifyUids` 与
`resolveUidToUinWithFallback`（批量 `uidToUin` + 前 10 条资料详情兜底，OB11 / Milky
`enrichment` 共用），`shared/buddy-req` 新增 `processInboundBuddyReqs`（unreadNums 短路 →
收窄 → 可处理性过滤 → 去重入口管线）。OB11 / Milky 的事件语义与日志口径不变。
