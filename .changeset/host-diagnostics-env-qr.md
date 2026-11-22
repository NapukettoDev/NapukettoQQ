---
"@napuketto/loader": minor
"@napuketto/kernel": minor
"@napuketto/cli": patch
---

收窄宿主诊断面、子进程环境与登录二维码生命周期（审计 H-01 / H-06 / L-01 上游 / L-03）。

- IPC `diag.*` 默认不注册，只有 `NAPUKETTO_DIAG=1`（或 `LaunchOptions.diagnostics: true`）才启用；启用后 6 个反射动作按目标方法 allowlist 执行，`diag.richMediaTmpPaths` 改为只读枚举，不再触发 setters。调用方应以 `NOT_FOUND` 判断诊断是否可用，并继续只把诊断用于本地显式调试。
- launcher 不再展开父进程 `process.env`：只继承平台基础变量、代理/证书、主配置、`NAPUKETTO_LOG_*` 与登记的控制标记；强类型 `LaunchOptions` 字段优先于 `extraEnv`，`false` 会删除继承标记。依赖任意环境变量透传的部署需改用 `extraEnv` 或登记的变量（`NAPUTO_QUICK_UIN` / `NAPUTO_QR_ONLY` / `NAPUTO_SMOKE` / `NAPUTO_PROBE` / `NAPUTO_LISTENER_RECORD` / `NAPUTO_DIAG` 及新前缀等价物）。
- `NAPUTO_QR_ONLY` 读取后删除，软重登不再被残留标记强制扫码；旧 `NAPUTO_*` 控制拼写在进入子进程前规范化为 `NAPUKETTO_*`。
- 新增可选公开契约 `LaunchOptions.log`（level / format / noBanner / colorize），映射到子进程 `NAPUKETTO_LOG_*`；日志不打印环境变量值。
- PID 统一按 `isValidPid` 校验（安全整数、`1..0x7fffffff`）；`runtime.json` 的 `selfHostPid` 也纳入形状守卫，非法值不再进入存活探测或树杀。合法 PID 的 signal 0 探测保持不变。
- 登录二维码默认落在 `<账号目录>/cache/qr/qrcode.png`（目录 `0o700`、文件 `0o600`、拒绝符号链接），登录成功/失败/超时/`stop()` 时删除；显式 `qrCodePath` 仍由调用方保留。日志不再打印 `qrcodeUrl`/票据原文，结构化脱敏新增 `qrcodeUrl` / `qr_code_url` / `qrcode_url`。

Bugly 外传仍只是未证实的报告主张；本次仅缩小自建宿主子进程可见的父进程环境，不宣称阻断外传。自建宿主依赖支持 `LaunchOptions.log` / `isValidPid` 的 loader 版本。
