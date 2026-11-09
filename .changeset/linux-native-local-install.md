---
"@napuketto/loader": minor
---

feat(loader): Linux 原生分支识别本地 deb 安装（`/opt/QQ` 扁平布局）

deb 装出来的 QQ 是扁平结构（`/opt/QQ/qq` + `/opt/QQ/resources/app/wrapper.node`），
没有 Windows 的 `versions/<版本>/resources/app/`，此前 loader 只认 `versions/`，
Linux 用户本机装了 QQ 也会被当成未安装、白下 190MB deb。新增 L1b 探测（仅 Linux
原生分支，`NAPUTO_QQ_DIR` 可覆盖）：校验 wrapper 为 ELF、版本取自
`resources/app/package.json`（缺失即跳过，不猜版本），命中即用本机安装，优先于
数据根缓存。实测 `/proc/<pid>/maps` 确认加载本机 wrapper、数据根未生成 `qq-files/`、
快速登录成功、优雅退出 `code=0`。Wine 分支行为不变。
