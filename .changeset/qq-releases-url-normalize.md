---
"@napuketto/loader": patch
---

fix(loader): 修复 QQ 官方安装包下载 403（追踪 issue #6 连续 18 天日报的真因）

根因不是「腾讯 CDN 封数据中心 IP」，而是 CDN 边缘 WAF 有一条**区分大小写**的规则匹配
字面量 `/QQNTV2/` 路径段：命中后边缘直接返回 `403`（`Content-Length: 0`）且**不回源**，
而源站对路径大小写不敏感——同一请求只把路径段写成小写 `/qqntv2/` 即正常返回。修复：
新增 `normalizeDownloadUrl()`，在唯一出站口 `downloadFile()` 统一归一化（同时覆盖清单 URL
与 `NAPUTO_QQ_URL`），清单内仍保存官方原样 URL 以便追溯，腾讯日后修掉该规则也无需回改。
CI 更新脚本（`scripts/qq-releases/update-qq-releases.ts`）同步归一化，qq-releases.json
随之补齐到 9.9.36。另修掉内置 `7zz` 缺失的 git 可执行位（原 `100644`，Linux/CI 上
`execFile` 直接 EACCES，7-Zip 解析实为死代码、一直静默回退字节扫描）。
