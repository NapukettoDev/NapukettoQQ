# @napuketto/loader

Napuketto 引导组件——**自建宿主**：标准 Node + stub 直接 `dlopen` `wrapper.node` 并启动 kernel，不拉起 QQ、不注入。Windows 用 PE `QQNT.dll`，Linux 用 `libnapuketto_stub.so` + `LD_PRELOAD`。

- **shared/** — 最底层工具：日志 / 数据根 / 包根与版本元数据 / 类型守卫
- **contract/** — 跨进程契约：IPC schema（zod 单一来源）、原生噪音行判定、协议键与 QR 标记
- **lifecycle/** — 进程治理：单实例锁 / cmdline 探活 / 优雅关停
- **qq/** — 腾讯产物获取链：定位安装 / 版本清单 / 下载 / 解包
- **boot/** — 宿主装配与拉起：launcher（装配环境变量 + PATH 前置 stub + spawn 标准 node）、linux-native、win-node
- **host/** — 自建宿主运行时：入口 `self-host`，内部按 `runtime` / `bootstrap` / `auth` / `protocols` / `ipc` 分层

## 注意

`native/` 为 Git Submodule（private 仓库 `NapukettoDev/Napuketto-Native`），含 stub QQNT.dll 源码与编译产物。clone 后需 `git submodule update --init --recursive`。
