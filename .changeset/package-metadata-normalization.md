---
"@napuketto/adapter": patch
"@napuketto/kernel": patch
"@napuketto/loader": patch
"@napuketto/media": patch
"@napuketto/network": patch
---

规范化 npm 发布元数据（仅 `package.json` 元信息，无运行时改动）：五个包统一补齐 `$schema`、
`keywords`、指向包内 README 的 `homepage`、`bugs`，`repository` 补上 `directory`，`author`
改为结构化对象；`description` 统一为英文并补全语义（`loader` 原中文描述改写为英文，与其余四个包一致）。
`adapter` 的 `exports` 与 `tsdown.entry`、`loader` 的 `files` 只调整键序，条目集合不变。

导出子路径、依赖声明与包版本均未变化，按 patch 发布，刷新 registry 上的描述 / 关键词 / 仓库链接。
`tooling/package-exports.test.ts` 的子路径白名单断言同步改为集合比较，不再把 `exports` 键序当契约。
