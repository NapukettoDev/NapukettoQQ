---
"@napuketto/loader": patch
---

fix(loader)：Linux 非 x64 架构不再使用内置 x64 `7zz`（arm64 解 deb 不再 `cannot execute`）

内置 `assets/7zip/7zz` 是 x86-64 ELF，在 arm64 上执行会直接 `cannot execute`（arm64
容器实测），导致 `ensureQqFiles` 的 deb 解包在 arm64 上必然失败。现在按架构分流：

- 新增 `bundledSevenZipSupported(platform, arch)`（Linux 仅 x64 用内置）与
  `findSystemSevenZip(path)`（PATH 扫 `7zz` → `7z`）
- `findSevenZip()`：`NAPUTO_7Z_PATH` > 内置（适用架构）> 系统 PATH
- `ensureLinuxSevenZip({ arch })`：非 x64 跳过内置/缓存/官网下载（三者都是 x64 产物），
  直接用系统 7-Zip；没有时抛可读错误（提示装 `7zip` / `p7zip-full` 或设 `NAPUTO_7Z_PATH`）

x64 Linux 行为不变（继续用内置 7zz，零网络依赖）。arm64 交付前其余缺口见
`docs/architecture/linux-native-host.md` 附录 E.2。
