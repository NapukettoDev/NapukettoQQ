---
"@napuketto/adapter": patch
---

fix(adapter): Linux 原生宿主入站消息可投递（元素变体 null 形状 + msgTime 单位归一）

真机复现：`NAPUTO_LINUX_NATIVE=1` 下他人消息到达 kernel，但 OB11 WS 收不到任何
`message` 事件。插桩确认不是原生调用挂起（`groupMemberRole` 566ms 正常返回），
而是两处 Linux 原生对象形状差异：

- **元素变体显式 `null`**：Linux 3.2.x 把未命中的元素变体置 `null`（Windows 省略
  字段），OB11 `hasGrayTip` / `hasFileElement` 用 `!== undefined` 判定 → 每条普通
  消息都被误判为 grayTip 转入 notice 分支后静默丢弃；Satori `hasSatoriGrayTip` 的
  `g === undefined` 同源（读 `null.subElementType` 抛错被事件通道吞掉）。统一改空值
  判定（`!= null`），并覆盖 `toGroupUpload` / poke 判定。
- **`msgTime` 单位**：Linux 为秒字符串、Windows 为毫秒，统一 `/1000` 会让 Linux
  事件时间退化成 1970。新增 `core/shared/time.ts` 的 `toUnixSeconds()` 按量级归一，
  OB11 消息事件 / notice / 历史消息翻译统一使用。

实测：群 `1101729931`（第二账号 `3054108135`）与自然群流量（群 `521584745`）的
文本 / 图片 / reply 消息均广播为 `post_type=message`、`message_type=group`、真实
`user_id` 与当前 Unix 秒时间；同时启用 OB11 + Satori 时两端口各自只收到本协议信封。
新增 null 形状回归单测与 `toUnixSeconds` 单测。
