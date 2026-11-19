---
"@napuketto/cli": patch
"@napuketto/kernel": patch
---

加固 `apps/cli` 的输入校验与凭据保护：

- `-q/--qq` 复用主配置 QQ 号规则做入口校验（非法格式 / 模板占位值 / 路径穿越 / 重复值 → `ConfigError`，exit 78），`runtime/state.ts` 与 `boot.ts` 增加数据根路径边界防御并拒绝停止哨兵保留值 `all`。
- `config apply` 在落盘前补充协议段 zod 校验；`.toml` 语法错误与 `.json` 统一包装为 `INVALID_PARAM`。
- 主配置 `accounts` 与 supervisor 显式 `-q` 均拒绝重复 QQ 号，避免并发拉起同一账号。
- `config list` / `config apply` 的 stdout 对 `token` 等敏感字段默认脱敏，新增 `--show-secrets`；配置文件在 POSIX 以 `0o600` 权限写入（kernel `CONFIG_FILE_MODE`）。
