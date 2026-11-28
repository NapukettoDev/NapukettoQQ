---
"@napuketto/kernel": patch
"@napuketto/adapter": patch
---

隔离群缓存失效前后的异步回填，防止退群、停用和软重登后旧请求污染新状态。OB11 和 Milky 会清理失效的群精华同步任务并合并同群触发，队列满时由后续更新事件补拉。
