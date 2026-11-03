---
"@napuketto/cli": patch
---

chore(cli): 终端登录二维码改用零依赖 `uqr` 渲染

`qrcode@1.5.4`（连同 `@types/qrcode`）会带进 `yargs@15` 整棵旧树，共 30 个包；`uqr`
自身零依赖、双格式（ESM/CJS）、`sideEffects: false`，只新增 1 个包。终端渲染按旧
`qrcode terminal + small` 的白底黑块 half-block 观感自行实现（`src/runtime/qr.ts`）：
uqr 的 `renderANSI` 每模块占全角空格、宽度翻倍（80 列终端折行即废码），
`renderUnicodeCompact` 用默认前景色画亮模块、浅色主题下反色；自绘版本与主题无关、
宽度恒等于模块数，终端显示/扫码行为与替换前一致。新增 `src/runtime/qr.test.ts`
把渲染结果解析回矩阵做 roundtrip 断言。
