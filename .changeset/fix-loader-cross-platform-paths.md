---
"@napuketto/loader": patch
---

fix(loader): 跨平台路径归一化——反斜杠 Windows 路径在 Linux（WSL/CI ubuntu）下 `basename`/`dirname` 不认 `\` 分隔符导致误判：`isNodeExecutable` 对反斜杠路径恒判非 node、`resolveQqInstall` 切错安装目录（报「QQ 版本目录不存在」）。非 win32 平台先归一化分隔符再取基名/父目录，win32 行为保持不变。
