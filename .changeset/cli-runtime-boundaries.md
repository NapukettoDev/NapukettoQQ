---
"@napuketto/cli": patch
---

修复 cli 运行期边界问题：单账号常驻结束时解绑 SIGINT/SIGTERM/SIGBREAK 监听、取消停止哨兵轮询与 kill 兜底定时器；多账号（含 `supervisor` 子命令）透传 `--qq-path`；日志配置缓存按显式 `dataDir` 重新解析，内联来源日志输出实际命中的环境变量名；配置模板把 KuroBot 的 leave/death 模板移回 `[accounts.kurobot]`；boot/supervisor 子进程输出改用带 64 KiB 单行上限的逐行切分，防止无换行超长流无界累积。
