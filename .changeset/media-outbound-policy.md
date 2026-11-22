---
"@napuketto/media": minor
"@napuketto/adapter": minor
"@napuketto/loader": minor
"@napuketto/cli": minor
---

协议媒体下载默认仅允许公网。OneBot 11（含 IPC 动作桥）、Satori 和 Milky 的受信任 LAN 部署可在对应账号协议段的 `media.outboundPolicy` 设为 `compat`。IPC 动态注入需使用支持该配置的 adapter。

`downloadUrl` 保留 LAN 兼容下载，`downloadPublicUrl` 支持首跳及同源重定向的自定义请求头。两者忽略传输及路由头并在跨源后清空调用者请求头。公共扩展名推断使用 MIME 白名单，响应头查询忽略大小写。
