---
"@napuketto/adapter": minor
"@napuketto/network": minor
"@napuketto/loader": minor
"@napuketto/cli": minor
"create-napukettoqq": minor
---

feat(milky): Milky 协议适配器 P0（第四协议，目标 Milky 1.3.0）——

- adapter：`@napuketto/adapter/milky` 子路径导出 `NapukettoMilkyAdapter` + `milkyConfigSchema`。单端口 HTTP（`POST /api/:api` 规范信封 + 401/404/415 语义；`GET /event` SSE/WS 事件推送）+ WebHook；P0 动作 9 个（get_login_info / get_impl_info / send_private_message / send_group_message / get_message / recall_*_message / get_friend_list / get_group_list），事件 2 个（message_receive 三场景 / message_recall）；类型层为官方 JSON Schema 的自研描述（P0 子集）；seq↔msgId 走 adapter 侧 MessageSeqIndex 双向映射（接收登记 + 历史扫描兜底）；发送核心含媒体 URI 解析（file:// / base64:// / http(s):// 落盘）
- network：SSE 事件流原语（`createSseResponse`）+ `HttpServer` 流式响应注入点（`onRawRequest`）与同端口 WS 升级注入点（`onUpgrade`）+ 空 body 响应支持（respond undefined）——均协议无关
- loader：`[accounts.milky]` 账号段读取与装配分支（段存在才装配，enabled=true 生效）
- cli / create：账号配置 schema 增 `milky` 段，配置模板与脚手架模板同步
