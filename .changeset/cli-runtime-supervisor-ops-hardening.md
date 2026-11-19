---
"@napuketto/cli": patch
"@napuketto/loader": patch
---

加固运行期状态管理、supervisor 生命周期与 `status/stop/restart` 运维路径：

- 托管模式明确 `runtime.json` 写入权责：supervisor 注入 `NAPUTO_SUPERVISOR_CHILD`，受管 boot
  只合并补充 `selfHostPid`/命令行指纹，不再把 `kind` 覆写成 `single-boot` 或丢失
  `restartCount`；退出时双方都走合并写，`status` 同时展示 self-host pid 与重启次数。
- `runtime.json` / `supervisor.json` 改为同目录唯一临时文件 + rename 原子替换（兼容
  Windows 覆盖语义，失败清理临时文件），并发读取不再可能拿到截断 JSON。
- supervisor 追踪守护重启定时器并在 `stopAll` 统一清理；无子进程且无待重启时结束常驻，
  全部账号因配置校验失败退出时透传退出码 `78`。
- 超时强杀在 POSIX 上升级为 SIGTERM → SIGKILL，并覆盖进程组与 `selfHostPid`；Windows
  监听 `taskkill` 的 `error` 事件。`stop`/`restart` 树杀前用命令行指纹做 PID 复用校验，
  避免误杀复用 PID 的无关进程。
- `stop -q <uin>` 改用独立哨兵文件 `<数据根>/napuketto.stop.<uin>`（loader 新增
  `writeAccountStopSentinel` / `removeAccountStopSentinel` / `accountStopSentinelPath`
  并对外导出），并发 stop 不同账号不再互相覆盖或提前删除请求；`cmdRestart` 在停止失败
  或 `process.argv[1]` 为空时中断，不再拉起空 `node` 进程。
