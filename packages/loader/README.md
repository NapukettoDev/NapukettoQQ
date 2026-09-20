# @napuketto/loader

NapukettoQQ 引导组件——**自建宿主**：标准 Node + stub QQNT.dll 直接 `dlopen` `wrapper.node` 并启动 kernel，不拉起 QQ、不注入。

- **launcher** — 装配环境变量 + PATH 前置 stub + spawn 标准 node
- **locate-qq** — 定位 QQ 安装与版本
- **host** — 自建宿主入口（self-host / session / login / protocols / bootstrap / smoke）

## 注意

`native/` 为 Git Submodule（private 仓库 `NapukettoDev/NapukettoQQ-Native`），含 stub QQNT.dll 源码与编译产物。clone 后需 `git submodule update --init --recursive`。
