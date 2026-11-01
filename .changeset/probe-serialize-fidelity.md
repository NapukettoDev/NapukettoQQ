---
"@napuketto/kernel": patch
---

fix(kernel): probe serialize 字节串保真 + 截断上限放宽（第二轮录制教训）

第二轮实机录制（Msg listener 修复后）拿全了 Msg 回调面，但两路关键载荷被
serialize 截断毁掉，批次三样本采不完整：

- **onRecvSysMsg 参数是 wire bytes 的带符号字节数组**（25 条）——数组 20 项
  截断只留前 20 字节，连信封 f1 块（64 字节）都装不下，msgType/subType 够不着。
- **grayTip 的 jsonGrayTipElement**（subElementType=17，表情回应通知载体）
  在深度 4 截断。

修复：

- TypedArray / 字节形态普通数组（全元素整数落 [-128,255]，≥16 项）→
  `{ kind: "bytes", size, data: base64 }`，保留上限 8192 字节 + truncated 标注
  （native 把字节块转带符号字节数组，按无符号还原）。
- MAX_SERIALIZE_DEPTH 4 → 8，MAX_ARRAY_ITEMS 20 → 64。

顺带收获（本轮录制，milky.md §0.8.5 重录结论）：friend_file_upload 源定型
（onRecvOfflineFileMsg / onFileMsgCome 同载荷 RawMessage 数组，fileElement 含
fileUuid/fileSize/file10MMd5/fileSha/fileSha3，fileSha* 接收侧为空待校准）；
reaction 证据链 = 群消息同 seq grayTip subElementType 17 + jsonGrayTipElement
（深度截断前未取得内容）；多设备上线回调 onLineDev{instanceId, clientType,
devUid} 入视野。
