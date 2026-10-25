---
"@napuketto/loader": minor
---

feat(loader): 支持 NAPKETTO_CONFIG_JSON 内联配置（嵌入式宿主契约）。主配置来源优先级全链统一为 NAPKETTO_CONFIG_JSON > NAPKETTO_CONFIG > NAPUTO_CFG_DIR 兜底：内联生效时零 toml 文件读取，协议段（按登录 uin）与 [log] 段均取自内联 JSON，cfgFile 返回哨兵 "<inline>"。协议段 seed 的 zod 校验失败包装为 ConfigError 并沿 startProtocols/bootstrap 重抛，self-host 以 78（EX_CONFIG）退出，宿主据此区分配置未就绪与运行时崩溃、免重启。
