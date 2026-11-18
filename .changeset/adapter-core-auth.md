---
"@napuketto/adapter": patch
---

`core` 新增协议层 Token 鉴权原语 `createTokenAuthorize` / `matchTokenCredential`，
参数化支持 Bearer 头、OB11 裸 `authorization` 头与 OB11 / Milky 的 `?access_token=`
查询参数；OneBot 11、Milky、Satori 的 transport 改为复用该原语，对外鉴权方言不变。
