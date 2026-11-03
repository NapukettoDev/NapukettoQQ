---
"@napuketto/network": minor
"@napuketto/adapter": minor
"create-napukettoqq": patch
---

**network（minor）**：新增 `WsSocket` 类型与 `isWsOpen()` 导出，协议层不再需要直接声明 `ws`；
`WsServer` 与 `HttpServer` 的同端口升级显式设置 `skipUTF8Validation: false`（文本帧进入
`JSON.parse` / 日志前强校验 UTF-8），并明确不装 `bufferutil` / `utf-8-validate` 原生加速插件
（Node 22/24 内置实现已足够快，也符合「只有 kernel 允许原生层」的约束）。

**adapter（minor）**：KuroBot 连接层改用 Node 内置 `WebSocket`（undici，子协议 / close code /
事件模型都覆盖），`ws` 与 `@types/ws` 降为 devDependencies（仅供测试的假服务端起真端口）——
发布的 adapter 包不再声明 `ws` 运行时依赖；Milky `/event` 的 socket 类型改走 network 的
`WsSocket` / `isWsOpen()`。

**create-napukettoqq（patch）**：终端着色改用 `node:util` 的 `styleText`，移除 `picocolors`
直接依赖（`NO_COLOR` / `FORCE_COLOR` / 非 TTY 纯文本行为不变）。

配套仓库级门禁（不单独占用版本号）：`pnpm-workspace.yaml` 开 `engineStrict: true`（Node 不满足
`engines` 时安装直接失败）、7 个发布包补 `publishConfig.provenance: true`（OIDC 发布带 SLSA
溯源，本地发布由 release 脚本自动 `--no-provenance`）、`tooling/package-exports.test.ts` 新增
catalog 强制令 / media 产物 50 KB 熔断 / `files` 白名单断言。
