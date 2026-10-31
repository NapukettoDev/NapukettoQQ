---
"@napuketto/kernel": patch
---

fix(kernel): 探测候选收集先快照 ctx.session 再枚举主 session

跟进 #33 的实机复验（2026-10-31 第二轮）：候选仍退化为单主 session——根因是
getMainSession 的 P1-4 遗留副作用（resolveMainFromStartup 把空壳主 session 写回
ctx.session），probe 先枚举主 session 后读 ctx.session，读到的已是空壳，去重后
自建 session 候选被吞。改为先快照 ctx.session 再枚举主 session，两个候选独立参与
countNonNullServices 评分。
