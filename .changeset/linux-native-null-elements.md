---
"@napuketto/kernel": minor
"@napuketto/adapter": patch
---

修复 Linux 3.2.x 原生 `wrapper.node` 入站消息元素显式 `null` 导致的空值崩溃（OneBot 11 收不到 message 事件 / `send_group_msg` / `get_group_msg_history` 报 `retcode 999`）：

- kernel：`picLocalCandidates`、全部 `*ToCanonical`、`readVideoThumbPath`、`emptyToUndefined` 与 `pttDownloadResult` / `findPttElement` / `findForwardElement` 统一改为 `== null` / `!= null`（同时兼容 Windows 的 `undefined` 与 Linux 的 `null`）。
- kernel：`pic-path-grace` 只处理 `elementType === PIC` 且 `picElement != null` 的元素；`MsgBridge.emitPicAware` 对 `hasPendingPicPaths` 增加异常隔离，单条畸形元素不再阻断整批 `channel.emit`。
- kernel：`RawElement` / `GrayTipElement` 及其子元素的可选字段扩展为 `T | null`，让编译器持续拦截同类漏网读取（类型面为扩展，读取方需按空值收窄）。
- adapter：同步修复 grayTip uid 收集、Milky 群成员变动/文件/转发、OB11 get_record / group_upload / notice 等处的 null 读取。
