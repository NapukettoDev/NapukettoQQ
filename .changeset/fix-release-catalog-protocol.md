---
"@napuketto/network": patch
"@napuketto/adapter": patch
"@napuketto/loader": patch
---

fix(release): 发布包不再泄漏 `catalog:` 协议（0.6.x–0.7.x 的 npm 包无法安装）

2026-11-03 引入 pnpm catalog 后，`catalog:` 写法进了三个包的运行时依赖：
`@napuketto/network`（hono / @hono/node-server / ws）、`@napuketto/adapter` 与
`@napuketto/loader`（zod）。`changeset version` 只改写 `workspace:*`、从不碰 catalog，
发布链也没有兜底，于是这些版本把 `"zod": "catalog:"` 原样发上 npm——用户侧
`npm install @napuketto/loader` 直接 `EUNSUPPORTEDPROTOCOL`（2026-11-10 Linux 原生宿主
nightly smoke 第一次走到「装已发布包」这一步时抓到；本地 `pnpm pack` 会改写 catalog，
所以此前的手工验证看不出来）。

修复在发布链（`tooling/release`）：发布前按 `pnpm-workspace.yaml` 的 `catalog:` 段把
`catalog:` 改写为真实版本范围、发布后恢复原样；改写完再断言四个依赖字段里没有
`workspace:` / `catalog:` 残留，有就中断发布。本组补丁版本用带修复的发布链重发，
代码本身无行为变化。
