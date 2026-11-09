---
"@napuketto/kernel": patch
"@napuketto/loader": patch
---

fix(kernel): Linux 原生宿主的 QQ 数据根改用 Napuketto 数据根（`<数据根>/nt_qq`），不再读写 `$HOME/Documents/Tencent Files`；`resolveQqUserDataRoot` 新增平台分流与 `dataRoot` 选项，loader 经 `NAPUTO_DATA_ROOT` 注入。
