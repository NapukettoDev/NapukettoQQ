---
"@napuketto/adapter": patch
---

协议 token 统一使用固定长度摘要与 timingSafeEqual 比较，覆盖 Bearer、裸头、查询参数及 Satori IDENTIFY，安全处理不同长度和 Unicode；修复 OB11 裸 Authorization 头大小写不一致，保留空 token、前缀与回退语义。此项为鉴权原语加固，不代表已证实存在可远程利用的时序攻击。
