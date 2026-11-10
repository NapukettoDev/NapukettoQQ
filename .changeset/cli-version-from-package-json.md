---
"@napuketto/cli": patch
---

fix(cli): `--version` 不再硬编码 0.0.1，改为运行时读自身 package.json

此前 `program.version("0.0.1")` 是写死的字面量，导致 npm 上无论发到哪个版本，
`napuketto --version` 都自报 `0.0.1`（2026-11-10 补发 0.5.14 后装机冒烟才发现）。
现在由 `src/cli/version.ts` 的 `cliVersion()` 读自身 `package.json` 的 `version`：
生产形态（tsdown 单文件 `dist/index.mjs`）命中 `../package.json`，源码直跑形态
命中 `../../package.json`，并校验 `name` 防读错文件；都读不到时兜底
`0.0.0-unknown`，不阻断启动。
