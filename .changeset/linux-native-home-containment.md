---
"@napuketto/loader": patch
---

fix(loader): Linux 原生宿主收敛 `HOME`/`XDG_*`，Bugly 崩溃目录不再写入用户目录

`libbugly` 的 `NativeCrashHandler` 无视 `desktopGlobalPath`，固定向
`$HOME/.config/QQ/crash_files/` 写崩溃记录（Stage 0b 发现）。原生分支现在把子进程
`HOME` 收敛到 `<数据根>/home`（`NAPUTO_LINUX_HOME` 可显式覆盖，无数据根时退到
`<账号目录>/home`），并把 `XDG_CONFIG_HOME` / `XDG_DATA_HOME` / `XDG_CACHE_HOME` /
`XDG_STATE_HOME` 派到该目录下；实测崩溃目录落在受管目录、用户 `$HOME` 零写入，
快速登录与优雅退出不受影响。wine / win32 分支行为不变。
