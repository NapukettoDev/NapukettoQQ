---
"@napuketto/loader": patch
---

私有 native 子模块目录重组：源码 `stub/` → `src/{win,linux}/`（`stub-linux.cc` 统一为 `.cpp`），预编译产物 `build/` → `prebuilt/{win32-x64,linux-x64}/`，构建脚本移入 `tools/` 并新增极简 CMake 入口。`defaultStubDir()` 与 Linux 默认 stub 路径随之上移（`native/prebuilt/win32-x64`、`native/prebuilt/linux-x64`），`files` 白名单同步——发布产物内容等价，仅包内路径变化；`--stub-dir` / `NAPUTO_STUB_DIR` / `NAPUTO_LINUX_STUB` 用法不变。
