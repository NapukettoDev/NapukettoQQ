---
"@napuketto/adapter": patch
---

refactor: 协议适配器协调层拆分（onebot11 / milky / kurobot 巨型 adapter.ts 分层）

- `adapter.ts` 瘦身为纯协调层（构造装配 / 生命周期 / 传输启停；OB11 另有 IPC 桥
  `subscribeOnly` / `unsubscribeOnly` 公共面）；各协议新增 `event-pipeline.ts`
  （事件通道订阅与派发、自消息过滤、去重缓存 fileKeys / essenceKeys / pinWatch）
  与 `enrichment.ts`（翻译前异步回填：批量 uidToUin、群实体、msgId 反查、精华
  diff 触发），翻译函数保持纯函数（ADR-008）。
- 公共面无变化：`Napuketto*Adapter` 类名、构造参数与公开方法签名不变，包导出
  子路径不变。
- 内联工具收拢 `core/shared/`：新增 `log.ts`（`truncRaw` / `sliceRaw` /
  `AdapterLoggerLike`）、uid-uin 的 `numericUin`、gray-tip 的 `findRevokeElement`。

纯结构调整，无行为变化。
