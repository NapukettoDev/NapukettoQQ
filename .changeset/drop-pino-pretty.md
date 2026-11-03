---
"@napuketto/kernel": patch
"@napuketto/cli": patch
---

refactor(kernel): pretty 日志格式改为自渲染，移除 pino-pretty 依赖

- kernel `log-format` 新增 pretty 渲染（多行彩色：`[HH:MM:ss.l] LEVEL (name/pid): 消息`
  + 逐行 `key: value`，嵌套对象/数组按 JSON 形状展开，`err.stack` 多行原样展开），
  三种控制台格式（pretty / single-line / json）统一由 kernel 自渲染。
- 删除 optional peerDependency `pino-pretty`（及其懒加载 `createRequire` 降级分支），
  `@napuketto/cli` 同步移除该直接依赖；安装体积与解析链少 19 个包。
- 时间戳统一记数值单调墙钟：pretty + `timestamp = "elapsed"` 时文件日志自此也是数值
  时间（此前被预渲染成 `+123.456s` 字符串），控制台仍按 timestamp 模式渲染。
