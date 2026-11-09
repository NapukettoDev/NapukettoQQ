---
"@napuketto/loader": minor
---

feat(loader): Linux QQ 原生文件 deb 管线（Stage 2）——清单 schema 2 增加平台/架构/核心版本，Linux 自动下载官方 deb 并用内置 7zz 三层解包，提取 `wrapper.node` / `major.node` / `*.so*` / `sharp-lib/` 到与 Windows 同构的缓存布局；Linux 原生模式定位阶段校验 ELF，拒绝误用 Windows 安装文件。
