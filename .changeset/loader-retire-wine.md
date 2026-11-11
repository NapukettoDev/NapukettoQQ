---
"@napuketto/loader": minor
---

feat(loader): Linux 退役 Wine，只走原生 ELF 自建宿主（ADR-027）

- **删除 Wine 分支**：`wine.ts`（`toWinePath` / `unixPathToWinePath` / `wineBinary` / `wineCheckError` / `wineInstallHint` / `buildSpawnCommand` / `SpawnCommand`）与 `tooling/wine/*` 两个冒烟脚本一并移除——`@napuketto/loader` 不再导出上述符号（破坏性变更，按 0.x 惯例走 minor）。
- **Linux 恒走原生宿主**：标准 Linux `node` + `libnapuketto_stub.so` + `LD_PRELOAD=<stub>:<libgnutls.so.30>`，不再下载 Windows `node.exe`、不做 `Z:\` 路径转换、不校验 `QQNT.dll`。`NAPUTO_LINUX_NATIVE=0` 只播报一句「已失效」，`NAPUTO_WINE` 不再读取。
- **定位逻辑**：Linux 平台恒校验 `wrapper.node` 为 ELF（PE 安装给出可读错误），`tryResolveLinuxLocalQq` 去掉 `linuxNative` 选项（平台即判定）。
- **保留** `win-node.ts`：win32 非 node 宿主（Bun / koishi CE）仍需要真 `node.exe`（系统 PATH 优先，缺失才下载）。
- **升级提示**：Linux 部署可卸载 `wine`，并删除 `<数据根>/runtime/win-node/` 与旧版 Windows QQ 缓存（不再读取）。
