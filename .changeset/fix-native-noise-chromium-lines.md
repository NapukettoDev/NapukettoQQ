---
"@napuketto/loader": patch
---

原生噪音表补 Chromium 原生日志行：QQNT 原生层把内部进度也标 ERROR 级写 stderr（QUIC 建链/关链、session stats 报告等），每次 spawn 稳定刷屏 70+ 行。CLI 转发与 koishi IPC 两条路径经共享判定同步过滤；FATAL 行不过滤（崩溃现场保留），wine/node 启动报错非此格式不受影响。
