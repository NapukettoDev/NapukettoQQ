---
"@napuketto/adapter": patch
---

refactor: inbound 域处理器分层（event-pipeline 拆订阅接线板 + inbound/ 域处理 + sysmsg 通用管线）

- 各协议 `event-pipeline.ts` 瘦身为纯订阅接线板（unsubscribes 管理 + applyConfig
  开关 + kernel 频道 → 域处理器路由）：onebot11 495→99 行、milky 628→97 行、
  kurobot 331→45 行。
- 事件域处理拆入各协议 `inbound/`：onebot11（message / sysmsg / essence /
  request / file-notice）、milky（base / message / sysmsg / essence / request /
  file-notice / pin）、kurobot（message / server-frames，另有 session.ts 共享
  状态：绑定集 / pending 表 / status 快照 / 接收过滤），单文件 ≤110 行。
- sysmsg 单条字节块「解码 → 信封 → 识别 → 分流 → 校准日志」通用管线收拢
  `core/shared/sysmsg.ts` `processSysMsgBlob`；onebot11 / milky 只持识别表与
  命中处理。解码失败日志级别保持协议既有口径（OB11 warn / Milky debug）。
- 顺手清理：OB11 notice 翻译失败补 debug 日志（丢弃整个事件的原语义不变）、
  milky 置顶基线播种失败补 debug 日志、OB11 群通知按 kernel `GroupNotify`
  类型消费（消除 unknown 属性断言）、milky 732:1 快路径载荷改守卫收窄。
- 公共面无变化：`Napuketto*Adapter` 类名、构造参数与公开方法签名不变，包导出
  子路径不变。

纯结构调整，无行为变化（上条日志补记除外）。
