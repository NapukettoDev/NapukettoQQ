---
"@napuketto/adapter": patch
---

adapter 跨平台不变量修复（Linux 原生宿主兼容）与生命周期边界加固。

时间归一：全部 `msgTime` 换算收敛到 `shared/raw-message.ts` 的 `toUnixSeconds`
（Windows 毫秒 / Linux 秒按量级自动识别），覆盖 milky 的 api / seq-index /
message-query / 事件翻译 / friend_file_upload 与 satori 的 `created_at` /
`timestamp`（Satori 规范毫秒级，归一后换算）——此前 Linux 秒级样本会被二次
除 1000 退化成 1970。

元素判空：变体字段存在性判定统一 `== null`（Linux 3.2.x 原生对象把未命中的
变体显式置 null，`=== undefined` 会漏判后直读字段抛错），覆盖撤回
（revokeElement）、群成员变动（groupElement）、语音/图片媒体（pttElement /
picElement）与 grayTip 循环守卫；OB11 错误响应（缺 action / 未知动作 404 与
请求处理异常兜底）透传 `echo`。

生命周期：`BaseProtocolAdapter.start/stop` 增加并发去重与 start↔stop 交错
等待；`reload()` 未启动时 no-op（原实现会对未启动实例重建传输，留下
started=false 但传输已运行、后续 stop 空转的状态不一致）；OB11 心跳启动前
清理残留定时器；Satori 非登录事件的 `login.sn` 不再混用全局事件序号（固定
0）并新增可选 `logger` 注入（翻译失败由静默吞错改为 warn 留痕）；
`KurobotConnection` 对非法 URL 的构造期异常走 error 日志 +
`onEnded({permanent: true})` 永久停止。

杂项：`MS_TO_SEC` 局部定义收敛到 `shared/uid-uin.ts`；修正 4 处指向
`core/shared/...` 的旧路径注释（目录重构前遗留）。
