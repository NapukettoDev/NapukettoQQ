---
"@napuketto/adapter": patch
---

fix(adapter): OB11 消息事件与 get_msg/历史消息的 sender.role 接群成员缓存判定 owner/admin——此前恒为 "member"（docs/protocols/onebot11.md 缺口清单项）。经 OneBotApi.groupMemberRole(s) 查 kernel GroupCache（缓存优先，缺失惰性回填；角色映射复用 GroupApi.roleToString），查询失败或未装配缓存时回退缺省 "member"，不阻塞消息上报；角色经 ReceiveTranslateContext.senderRole 注入，翻译层保持纯函数
