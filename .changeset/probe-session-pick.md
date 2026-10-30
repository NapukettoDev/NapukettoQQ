---
"@napuketto/kernel": patch
---

fix(kernel): 运行时探测按服务可用度选主 session

自建宿主下 QQ 主 session（getNTWrapperSession(nt_x)）未被 init，其 get*Service
恒返回 null——napuketto-probe(-late).json 里 64 个服务方法面全空（2026-10-31 实测）。
probeSession 改为收集全部候选 session（主 session + kernel 自建 session），按
countNonNullServices 评分选服务实例最多者为主探测目标，落选者记入
sessionAlternates（方法数 + 评分）。

顺带：probe.ts 全函数拆小（fallow 复杂度门禁口径，probeStartup/
extractSessionIds/probeSessionById/probeSessionByName 等全部 cyc <= 4），
行为不变；probe-utils 增补候选评分单测（isServiceGetter / countNonNullServices /
pickPrimaryCandidate）。
