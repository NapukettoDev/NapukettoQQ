---
"@napuketto/cli": patch
"@napuketto/adapter": patch
"@napuketto/loader": patch
---

修复 Docker 部署下登录成功却秒退（issue #144）：

- boot 进程透传 self-host 的异常退出码（含 78），supervisor 的「配置失败免重启」恢复生效；
- 正向 WS 对端未启动/不可达时不再拖垮宿主，warn 后按 `reconnectDelayMs` 后台退避重连；
  Docker Compose 补齐 `host.docker.internal:host-gateway` 映射；
- 引导/协议装配致命错误同步输出到 stderr（含 `napuketto-boot.log` 路径，不污染 IPC stdout JSON）；
- supervisor 对运行不足 30s 的连续秒退按指数退避（60s 封顶）重启，稳定运行后计数清零。
