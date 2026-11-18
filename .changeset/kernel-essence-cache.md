---
"@napuketto/kernel": patch
"@napuketto/adapter": patch
---

群精华列表缓存与串行 diff 同步器下沉 kernel 缓存层（ADR-028）：`@napuketto/kernel` 新增
`EssenceListSync` / `diffEssenceList` / `narrowEssenceGroupArg` 及 `EssenceAddedItem` /
`EssenceCacheEntry` / `EssenceDiffResult` / `EssenceListSyncDeps` 类型导出
（`src/cache/essence-cache.ts`）；`@napuketto/adapter` 的 `shared/essence.ts` 只保留
`extractEssenceSetSysMsg`，OB11 / Milky 的事件语义与日志口径不变。
