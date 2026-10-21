---
"@napuketto/kernel": patch
"@napuketto/media": patch
"@napuketto/loader": patch
---

fix(packaging): `exports["."]` 顶层补 `types` 条件，修复 NodeNext 类型解析

双格式包（`dist` 同时产出 `.mjs` / `.cjs`）此前只在 `import` / `require` 分支内声明
`types`，只读取顶层 `types` 条件的解析器拿不到声明文件。现于 `exports["."]` 顶层补
`"types": "./dist/index.d.mts"`，并保留分支内各自的 `types`——顶层这行必须排在
`import` / `require` 之后，否则 CJS 消费者会被条件匹配劫持到 ESM 声明文件
（attw: Masquerading as ESM）。

新增 `tooling/package-exports.test.ts` 锁定该形状；attw（node10 / node16 CJS /
node16 ESM / bundler）与 TS 5.9 / 7.0 消费者矩阵验证通过。
