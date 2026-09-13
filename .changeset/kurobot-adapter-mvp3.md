---
"@napuketto/adapter": minor
"@napuketto/loader": patch
"@napuketto/cli": patch
"create-napukettoqq": patch
---

feat(adapter): 新增 kurobot 协议适配器（KuroBot MVP-3 群服互通）

账号 TOML 配了 `[accounts.kurobot]` 段即启用：作为 kurobot-ws **客户端**主动连入
KuroBot 服务端（Minecraft 服务器），实现 QQ 群 ↔ MC 双向互通——QQ 群文字进游戏
广播、游戏聊天/进服/退服/死亡事件渲染进群、群命令前缀转发为游戏命令（结果回群）。

- 连接层自建（子协议 `kurobot-ws.v1`、应用层 ping 15s、断线指数退避 1s→60s、
  close 1002/1008 停止重连）；协议 schema 镜像 KuroAdapter `bridge/protocol`
  0.3.1（golden 帧对表锁漂移）。
- 配置段：`url` 必填，`token`/`commandPrefix`/`pingIntervalMs`/四个渲染模板可选
  （缺省见 cli 模板注释）；段存在即启用、不写不启用。
- 装配：loader 按账号段装配（非 IPC 模式）；cli `config-parse`/模板与
  create-napukettoqq 脚手架模板同步。
