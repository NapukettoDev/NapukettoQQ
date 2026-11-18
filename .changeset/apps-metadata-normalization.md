---
"@napuketto/cli": patch
"create-napukettoqq": patch
"@napuketto/kernel": patch
---

补齐应用包与 kernel 的发布元数据（仅 `package.json` 元信息，无运行时改动）：

- `@napuketto/cli` / `create-napukettoqq`：补 `$schema`、`keywords`、指向包内 README 的 `homepage`、
  `bugs`、结构化 `author`；`create-napukettoqq` 的 `description` 改为英文并补全语义（与其余包口径一致）。
  `files` / `bin` / `scripts` / 依赖段只调整键序，条目集合不变。
- `@napuketto/kernel`：`author.name` 与根 `package.json` 统一为 `Oppenheymu`（上一轮遗漏，registry
  上的作者字段需重新发布才会刷新）。
- 根 `package.json` 为 private，不参与发布，仅同步 `author`。

导出子路径、依赖声明与运行时行为均未变化，按 patch 发布以刷新 registry 上的描述 / 关键词 / 作者字段。
