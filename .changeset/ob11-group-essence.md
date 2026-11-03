---
"@napuketto/adapter": minor
---

feat(adapter): OB11 group_essence 群精华变更通知接线（onebot11.md §4.2 欠账清零）

数据源复用 Milky 批次三成果（diff 翻译层上移 `adapter/src/core/essence.ts`
共享，milky 行为不变）：

- **唯一发射路径 = 列表 diff**：`Group/onGroupEssenceListChange`（录制实证
  payload 首项群号）→ getEssenceMsgList 全量 diff（基线未建立只建基线，
  essenceChain 串行防乱序）。
- **sysmsg 732:1 作加速触发器**：push 内无 sender/operator，不直接翻译，
  命中后踢入同一串行链——diff 幂等 + 串行天然去重。
- **字段口径**：sender_id 必填（列表 sender_uin / prev 缓存回填，缺失跳过
  事件）；operator_id 仅 add 回填 add_digest_uin（类型改为可选，delete 无
  任何数据源）；message_id 经 fetchMessages 近段扫描（60 条）→
  MessageUnique.alloc 幂等分配（与消息事件同一空间，可被 get_msg 反查，
  对照 recall 的 msgSeq 错位），解析失败跳过事件 + 校准日志。
- 顺手修正文档过期描述：sysmsg 识别表已含 732:21（group_card），
  "识别表为空" 表述更新；OB11Adapter sysmsg 处理 JSDoc 归位。
