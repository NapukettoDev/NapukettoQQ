---
"@napuketto/adapter": patch
---

adapter 静默降级分支治理与测试类型安全化（结构重构会话 5/5）。

生产代码：fail-soft 降级分支补齐可观测日志——milky（api/enrichment/transport/动作层
17 处）、onebot11（OneBotApi 新增可选 `logger` 字段并贯穿 media/history/send/enrichment
8 处）、core（`ensureSilk` 转码失败可选 logger warn）、kurobot（版本探测降级 debug）。
kernel API 调用失败 warn、纯解析兜底 debug 或保留映射语义注释；sysmsg 解码三态与 satori
翻译层按既有口径保留。`milky/api` 的 uin→uid 失败现以 `cause` 保留原始错误。

测试：全包 `as unknown as` 强转 153 → 43（新增 `core/__tests__/stub.ts` 的
`stub<T>`/`stubList<T>` 强类型桩工厂 + 各协议 test-support 强类型工厂）；合并
`*-branches`/`*-extra` 碎片测试 5 个到对应主测试文件（用例逐条保留）。

纯结构调整与日志增补，不改协议信封、注册表与动作语义。
