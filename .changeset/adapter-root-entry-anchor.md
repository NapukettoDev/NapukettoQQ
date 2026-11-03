---
"@napuketto/adapter": patch
---

refactor(adapter): 根入口 `src/index.ts` 改为「dist 路径锚点」注释（ADR-014），并移除无人使用的
`ProtocolId` 类型导出。根入口运行期本就只有 `export {};`——它的真实职责是让包根可被
`import.meta.resolve()` 解析，供 cli 注入 `NAPUTO_ADAPTER_ENTRY`、loader 按 `index.mjs` 字符串
替换推出各协议子入口；协议面继续只走子路径（./core、./onebot11、./satori、./kurobot、./milky）。
