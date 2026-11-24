---
"@napuketto/kernel": patch
"@napuketto/media": patch
"@napuketto/network": patch
"@napuketto/adapter": minor
"@napuketto/loader": patch
"@napuketto/cli": patch
"create-napuketto": minor
---

refactor(brand)!: 品牌与仓库名去掉 QQ 后缀，统一为 `Napuketto`

- 品牌面（全部包）：仓库、镜像、脚手架与文档统一为 `Napuketto` —— 仓库 `NapukettoDev/Napuketto`、镜像 `ghcr.io/napukettodev/napuketto`；npm 脚手架改名为 `create-napuketto`（`pnpm create napuketto`），其在 monorepo 内的目录同步改为 `apps/create`。
- 协议自报实现名（`@napuketto/adapter`）：统一为 `napuketto` —— OneBot 11 `get_version_info.app_name`、Milky `get_impl_info.impl_name`、KuroBot `hello.client` 缺省 `napuketto/<版本>`。
- CLI 与模板（`@napuketto/cli`）：启动 banner 去掉 `QQ` 字符画、`napuketto.toml` 模板标题与 KuroBot `client` 示例文案同步为 `Napuketto` / `napuketto`。
- 包元数据（其余包）：`description` / `homepage` / `bugs` / `repository` 指向新仓库名，`keywords` 移除品牌相关 `qq`（保留 `qqnt` 平台关键词）。
- 保持不变（运行契约）：QQ NT 原生文件名与安装路径（`QQ.exe` / `QQNT.dll` / `wrapper.node` / `/opt/QQ` / `nt_qq`）、各协议 `qq` 字段、`napuketto.toml` 的 `qq` 字段、`-q` / `--qq-path` 参数与 `NAPUKETTO_QQ_*` 环境变量。
