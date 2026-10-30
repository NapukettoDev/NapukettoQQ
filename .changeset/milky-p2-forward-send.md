---
"@napuketto/adapter": minor
---

feat(adapter): Milky forward 发送段落地（P2 批次一）

Milky 发送消息段补全至 10/10：send_private_message / send_group_message 现支持
forward 段（messages 任意内容组装）。实现走临时消息法（kernel 零改动）：逐条
临时发送 → buildMultiForwardMsg 组装转发 → best-effort 撤回临时消息。

已知差异（待实机联调校准）：节点发送者恒为机器人自己（user_id / sender_name /
time 不参与组装）；title / preview / summary / prompt 忽略；临时消息在撤回前
可见、其撤回会产生 message_recall 事件（operator 为自己）；forward 段须单独发送。

配套：MilkyApi 增可选 logger（动作层可观测出口，服务于撤回失败 warn）。
P2 批次二（群公告 / 置顶 / nudge 发送 / 群文件下载地址 / resource 反查 /
重命名文件夹 / 上传等 + 5 个无源事件）依赖实机探测产物（NAPUTO_PROBE=1），见
docs/protocols/milky.md §0.6。
