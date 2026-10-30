---
"@napuketto/adapter": minor
"@napuketto/loader": minor
---

feat(milky): Milky 协议 P1 扩面——动作 9 到 49、事件 2 到 15、转发内容反查

- 动作扩面 40 个：资料/票据（get_user_profile / get_friend_info / set_avatar /
  set_nickname / set_bio / get_cookies / get_csrf_token）、好友操作（send_profile_like /
  delete_friend / get_friend_requests / accept/reject_friend_request）、消息
  （get_history_messages / get_forwarded_messages / mark_message_as_read）、群管与精华
  （get_group_info / get_group_member_list / get_group_member_info / set_group_name /
  set_group_member_card / set_group_member_admin / set_group_member_mute /
  set_group_whole_mute / kick_group_member / quit_group / get_group_essence_messages /
  set_group_essence_message / send_group_message_reaction）、群通知与应答
  （get_group_notifications / accept/reject_group_request /
  accept/reject_group_invitation）、群文件（get_group_files / move_group_file /
  rename_group_file / delete_group_file / persist_group_file / create_group_folder /
  delete_group_folder）。
- 事件扩面 13 个：friend_request / group_join_request / group_invited_join_request /
  group_invitation（Group/Buddy 事件通道）、group_member_increase / decrease /
  group_mute / group_whole_mute / group_name_change / group_disband（grayTip 系）、
  friend_nudge / group_nudge（aioOp best-effort + 校准日志）、group_file_upload
  （群场景文件消息替代 message_receive）。
- 合并转发：接收段 forward_id 改为 resId（规范「转发消息 ID」语义），
  MessageSeqIndex 增转发索引，get_forwarded_messages 经索引定位会话。
- 装配：loader services.self 增 uid；milky 装配透传 profileLikeApi / ticketApi /
  webApi / groupNotifyApi / richMediaApi 与群/好友事件通道。
- 翻译共享收敛到 adapter core（uid→uin 解析 / request 上下文 / BuddyReq 防御收窄 /
  grayTip 未翻译提取器），OB11 行为不变。
