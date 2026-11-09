---
"@napuketto/kernel": minor
"@napuketto/loader": minor
---

feat: Linux 原生宿主 Stage 1（平台参数 + `NAPUTO_LINUX_NATIVE` 开关分支）

- kernel：按 `process.platform` 生成 KLINUX/KMAC/KWINDOWS 平台参数；qua 优先从
  `major.node` 扫描，`buildEngineConfig` / `buildSessionConfig` 支持显式平台覆盖。
- loader：新增 Linux 原生分支（标准 node + 最小 stub `.so` + `libgnutls` 预加载），
  缺省关闭，Wine 仍是现行实现。
- native：新增 Linux stub 源码、构建脚本与 x64 预编译产物。
