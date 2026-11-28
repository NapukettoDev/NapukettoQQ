# CLI 命令契约验证

在 Windows x64、Node.js 24.16.0 上，以 `ef8fea7` 为基线，在独立工作树安装锁定依赖并构建。命令用例执行 `apps/cli/dist/index.mjs`。账号与凭据均为测试数据，TOML 和进程状态文件位于临时目录。

- `pnpm test:quiet apps/cli` 通过 36 例，其中新增 11 例命令用例。配置覆盖默认启动和 `config validate` 的来源选择、非法内联退出 `78`，以及 `config list` / `config apply` 的 stdout 与写盘值。
- 临时改动 `resolveCliConfigSource`，让显式文件路径抢占内联配置。重建后 `config validate` 仍退出 `0`，但 stdout 来源从 `inline` 变为 `file`，断言如预期失败。恢复源码并重建后，5 例配置命令测试通过。
- `pnpm check`、`pnpm exec fallow architecture --boundaries` 和 `pnpm test:quiet` 通过。全量 62 个文件，1135 例通过、3 例跳过。

进程测试通过真实存活探测和系统命令行查询作出判断，以预置的状态文件模拟 PID 指纹错配。测试记录终止和 detached 拉起请求，真实 PID 回收、树杀、原生宿主重启留待运行环境验证。

额外实测发现，`stop -q` / `restart -q` 的 `-q` 被根命令消费。空状态下 `stop -q` 进入全量分支并退出 `0`，`restart -q` 记录到全量拉起参数。命令套件通过全量 `stop` / `restart` 覆盖共用的身份判断，单账号入口的路由修复与回归验证仍待完成。
