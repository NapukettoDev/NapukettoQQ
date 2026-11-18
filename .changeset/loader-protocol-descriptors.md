---
"@napuketto/loader": patch
---

收敛协议段读取与 adapter 子路径校验为表驱动（`PROTOCOL_KEYS` / `hasProtocolSurface` / `importSubpathModule`）；可选协议 `satori` / `kurobot` / `milky` 改为账号配置段非空时才动态加载对应子路径并实例化，未启用协议不再触发模块加载（兑现 ADR-014 按需加载）。
