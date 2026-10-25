---
"@napuketto/loader": patch
---

fix(loader): 发布产物恢复 native/build/stub-test-env（stub QQNT.dll）——0.0.36 起发布流水线 checkout 未检出私有 submodule，`files` 条目匹配不到文件被 npm 静默忽略，零配置自建宿主报「stub QQNT.dll 未找到」。发布流水线把 NapukettoBot App 安装到私有仓 Napuketto-Native 并于 checkout 检出 submodule，新增 `npm pack --dry-run` 打包守卫断言关键资产入包；包内补 NOTICE 澄清该 DLL 为自研符号转发 stub、非腾讯原始二进制
