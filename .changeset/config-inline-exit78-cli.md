---
"@napuketto/cli": minor
---

feat(cli): NAPKETTO_CONFIG_JSON 内联配置注入、配置校验失败退出码 78、config validate 子命令。内联优先级高于 NAPKETTO_CONFIG 文件（内联生效时不读/不写/不校验任何 toml 文件，模板不生成，启动日志声明配置来源）；主配置校验失败一族（占位值/必填缺失/形状非法/解析失败）进程退出码 78（EX_CONFIG 惯例），supervisor 对 78 退出的账号子进程不再守护重启；新增 `napuketto config validate`（--config <path> / --config-json <json> 二选一，无参校验生效配置，纯只读，exit 0 合法 / 78 校验失败 / 1 用法错误），供宿主拉起前预检。
