---
"@napuketto/kernel": patch
---

fix(kernel): 录制器 Msg listener 精确名选择 + getPinnedContacts topFlag 适配（首轮录制结论，milky.md §0.8.5）

2026-11-01 首轮实机录制（约 4 分钟窗口，11 服务全部挂上）暴露两处修复：

- **录制器 add 方法误选**：MsgService 有 5 个 add*Listener，正则按字母序选中
  `addKernelMsgImportToolListener`——真 listener 没挂上，Msg 回调面（onRecvMsg
  基线 / reaction 候选 / onRecvSysMsg / onRecvOfflineFileMsg）零捕获。改精确名
  `addKernel<简称>Listener` 优先、回退正则（裸 addListener 服务），单测加
  ImportTool/Notify decoy 锁定回归。
- **getPinnedContacts 置顶字段**：listener 载荷实测置顶字段名为 topFlag
  （1 = 置顶），非批次二假设的 isTop——pinnedOf 改双字段兼容
  （topFlag === 1 || isTop === true），类型层补 topFlag / topFlagTime。

录制结论（按名 Get 反射确认 / essence 回调只给群号需列表 diff / peer_pin 翻转
须 set_peer_pin 自触发 / chatType=7 影子记录与 Buddy 首推噪声）已落
milky.md §0.8.5 与 kernel design.md §10，重录窗口待本修复合入后进行。
