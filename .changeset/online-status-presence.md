---
"@napuketto/loader": patch
---

fix(loader): 引导装配补在线状态注册（真机终验发现 I：半在线导致服务端不推送消息）

`createKernelServices` 在 session 就绪后调用 `MsgApi.setOnlineStatus`（status=10，
与 OB11 set_online_status 动作缺省一致）。此前自建宿主引导链无人调 setStatus——
真 QQNT 客户端启动即上报在线，缺这一步 = NT 会话半在线：msf 连接可用、消息可发，
但腾讯侧设备不在线，服务端不推送实时消息（群消息收不到、他端显示「电脑未登录」；
2026-09-15 KuroAdapter 真机终验出站方向全通、入站零到达，实证定位）。注册失败仅
告警不阻断 boot。IPC 与协议（cli）模式共用此装配面，软重登重装配时自动重报。
