---
"@napuketto/kernel": minor
"@napuketto/adapter": minor
"@napuketto/loader": patch
---

feat(adapter,kernel,loader): Milky P2 批次二——15 动作接实机探测 kernel 出口（milky.md §0.7）

实机探测（NAPUTO_PROBE=1，names-only 修复后）拿到 56 个服务方法面，批次二据此设计；
规范形状取官方 API 文档（1.3.0，MIT）。全部「方法名实测确认、参数待校准」——失败抛
KernelError，原始响应经 MilkyApi.logger 记 debug 供实机校准。

kernel 新出口：

- MsgApi：file 元素发送链（P2-2 预留口子，pic/ptt/video 同款 NapCat 式
  md5 → getRichMediaFilePathForGuild(FILE) → copyFile → fileElement）+
  sendNudge / setContactTop（setContactLocalTop）/ queryFavEmojis
  （queryFavEmojiByDesc）。
- GroupApi：getGroupAnnouncements / publishGroupAnnouncement
  （uploadGroupBulletinPic + publishGroupBulletin 两步）/ deleteGroupAnnouncement /
  setMemberSpecialTitle（setIdentityTitleInfo）/ setGroupAvatar（setHeader）。
- RichMediaApi：renameGroupFolder（renameGroupFile 同款 5 参）+
  getGroupFileDownloadUrl（getGroupFileList 按 fileId 查 url 字段）。
- 新增 RecentContactApi（getRecentContactList，get_peer_pins 数据源）；
  loader kernel-services 装配 + assemble-protocols 透传。
- **修复 getGroupFileList 解包**：旧逻辑 `result !== 0` 即抛错 + extractFileList(0)
  恒空——真实返回形状（result 即列表 / 顶层列表 / 嵌套 items）下要么误抛要么恒空
  （P1 群文件列表实机必挂，此前无实机路径触达）。改宽松解包（checkLooseResult +
  result/raw 双位提取）。

adapter 新动作 15 个（注册表 49 → 64）：send_friend_nudge / send_group_nudge /
get_peer_pins / set_peer_pin / get_group_announcements / send_group_announcement /
delete_group_announcement / set_group_avatar / set_group_member_special_title /
get_custom_face_url_list / get_resource_temp_url / upload_private_file /
upload_group_file / get_group_file_download_url / rename_group_folder。

已知差异（文档明示，milky.md §0.7）：get_resource_temp_url 当前 resource_id 即临时
链接原样返回（无独立资源索引）；upload_group_file 走消息发送链（群内产文件消息，
生态同款），parent_folder_id 暂不参与定位；get_group_file_download_url 仅根目录
可达。get_private_file_download_url 延后批次三（rkey/TriSHA1 校准）。

fallow：kernel apis 实现文件加入 ignoreFindings（公开方法全部跨包消费，静态图
看不见；任一改动行位移即把存量成员翻成「本次引入」卡死增量门禁，与 barrel 豁免
同根因）。
