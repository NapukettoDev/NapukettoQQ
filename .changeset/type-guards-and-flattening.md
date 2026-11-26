---
"@napuketto/kernel": patch
"@napuketto/adapter": patch
"@napuketto/loader": patch
"@napuketto/cli": patch
---

消除重复类型守卫、强拆的二级 switch 与一次性微函数（零运行时行为变更）：

kernel 新增 `hasNullableStringProp` / `hasNullableNumberProp` / `hasOptionalStringProp`，
群成员守卫收敛为单一实现；adapter 与 cli 改用统一守卫。milky segments、sysmsg 解码、
satori 解析与 OB11 段守卫收敛为单一 switch；probe / log-format / loader 稳定结构改为具名接口。
