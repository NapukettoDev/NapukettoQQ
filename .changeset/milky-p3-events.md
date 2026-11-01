---
"@napuketto/kernel": minor
"@napuketto/adapter": minor
"@napuketto/loader": patch
---

feat(kernel,adapter,loader): Milky 批次三——5 个无源事件接线 + sysmsg 识别表共享化（milky.md §0.8.6）

三轮 listener 录制 + set_peer_pin 自触发翻转实验取齐证据后，Milky 事件面补齐
批次三 5 个事件（此前 P1 事件覆盖缺口）：

- **peer_pin_change**：新增 kernel RecentContactBridge（onRecentContactListChangedVer2
  转发，录制实证条目含 chatType/topFlag/topFlagTime）；milky 按「同会话 topFlag
  翻转」检测广播（回调随消息活动高频快照，不能见条目就广播），启动以
  getPinnedContacts 播种基线（PinnedContact 新增 peerUin）。
- **friend_file_upload**：Msg 桥补转发 onFileMsgCome（录制实证与
  onRecvOfflineFileMsg 同载荷），onRecvOfflineFileMsg 参数类型同步收窄为
  RawMessage[]；milky 双回调按 msgId 去重；file_hash 官方语义 TriSHA1、实测取
  file10MMd5（md5）充值（FileElement/RawMessage 补录制实证字段）。
- **group_message_reaction**：sysmsg 732:16（识别表实证）；operator 不在原生
  push（f4 为 bot 自身占位）——user_id 省略（P1 不产出半成品字段惯例）。
- **group_essence_message_change**：732:1 set 快路径 + onGroupEssenceListChange
  → getEssenceMsgList 列表 diff（remove 路径 + operator_id=add_digest_uin 回填；
  取消精华无独立 sysmsg 只能 diff 发现）；双路径去重缓存谁先到谁广播。
- **bot_offline**：新增 kernel LoginBridge（loginService 由装配注入
  ctx.wrapper.loginService，onLoginDisConnected/onLogoutSucceed 转发）；回调
  载荷零样本，reason 暂为固定值 + raw 校准日志待野捕。

sysmsg 解码层（wire-format 解码 / 信封提取 / 参数收窄）自 onebot11/helper 上移
adapter/src/core 共享，识别层泛型化 SysMsgKindRule<TEvent>：
onebot11 识别表不再是空表——732:21 群名片变更（OB11 group_card，三轮录制首个
实证条目，uid→uin 经 collectUids 钩子批量解析）；milky 识别表 732:16 / 732:1。

loader 装配：kernel-services 新增 RecentContact/Login 通道与桥（dispose 面随
之扩展），IPC 转发与 milky 传参同步接线。
