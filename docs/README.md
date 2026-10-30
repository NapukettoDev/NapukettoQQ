# NapukettoQQ 文档

> 代码是唯一事实来源。本目录只解释架构、机制、约束与操作流程；接口签名、字段默认值、
> 动作列表、包版本以源码与 `package.json` 为准。文档与代码冲突时，以代码为准并顺手修文档。

## 阅读顺序

1. 根目录 [AGENTS.md](../AGENTS.md)——工程指南：红线、工作流、代码风格。开始任何工作前必读。
2. [architecture/overview.md](architecture/overview.md)——项目定位、包结构、依赖方向、分层红线。
3. [architecture/runtime.md](architecture/runtime.md)——自建宿主启动链、登录与 session、调用与事件数据流。
4. [guides/configuration.md](guides/configuration.md)——`napuketto.toml` 字段、路径解析、环境变量。
5. 按需读协议文档：[OneBot 11](protocols/onebot11.md)、[Satori](protocols/satori.md)、
   [KuroBot](protocols/kurobot.md)；[Milky](protocols/milky.md) P0 已落地（规划稿含 P1/P2 待办），
   动手前再读。
6. 对应包的 `docs/design.md`——模块级设计、实测结论与实现细节（见下方“包内设计书”）。

做运维、排障或发版时直接读对应的指南，不必从头开始。

## 文档地图

| 文档 | 内容 |
|---|---|
| [architecture/overview.md](architecture/overview.md) | 项目定位、包职责、依赖方向、分层原则、硬性红线 |
| [architecture/runtime.md](architecture/runtime.md) | 进程拓扑、启动序列、QQ 文件来源、登录/session、数据流、多账号与 IPC |
| [architecture/decisions.md](architecture/decisions.md) | 现行 ADR 与已废止路线（只保留仍然约束代码的结论） |
| [guides/development.md](guides/development.md) | 本地开发、构建顺序、测试、CI、changeset、代码风格 |
| [guides/configuration.md](guides/configuration.md) | 全局 TOML、账号内协议段、传输实例默认值、数据目录、环境变量 |
| [guides/operations.md](guides/operations.md) | 单实例锁、停启与状态、日志、登录/文件/wine/噪音排障 |
| [guides/release.md](guides/release.md) | changeset → CI 发布链、OIDC、仓库一次性配置、补发与排障 |
| [protocols/onebot11.md](protocols/onebot11.md) | OB11 传输、动作面、事件面、ID 映射、已接线与待校准项 |
| [protocols/satori.md](protocols/satori.md) | Satori HTTP RPC / WS 事件、动作与 501、元素编解码、ID 映射 |
| [protocols/kurobot.md](protocols/kurobot.md) | KuroBridge WS 客户端、连接状态机、QQ ↔ MC 映射、配置与限制 |
| [protocols/milky.md](protocols/milky.md) | Milky 1.3.0：**P0 已实现**（传输/9 动作/2 事件/装配），其余为实施规划（65 接口 × kernel 覆盖、21 事件 × 数据源、P1/P2 待办） |

## 包内设计书

跨包机制进本目录；单包内部实现细节留在包内，避免重复维护。

- [packages/kernel/docs/design.md](../packages/kernel/docs/design.md)——事件桥 / 事件通道 / API 实现细节 / 探测产物 / 视频发送
- [packages/adapter/docs/design.md](../packages/adapter/docs/design.md)——onebot11 事件链 / 热更新 / 媒体动作 / sysmsg 解码 / kurobot
- [packages/loader/docs/design.md](../packages/loader/docs/design.md)——QQ 文件来源 / wine / IPC / 登录相位机与软重登
- [apps/napuketto-create/docs/design.md](../apps/napuketto-create/docs/design.md)——脚手架交互与生成骨架
- `packages/loader/native/docs/HANDOVER-V11.md`——载具层闭源交接，位于私有 submodule，不在公共仓库

Koishi 适配器自 2026-10-18 起是独立仓库
（`NapukettoDev/koishi-plugin-adapter-napuketto`），其设计与发布文档在该仓库内；本仓只维护
`@napuketto/*` 的公开契约。

## 维护约定

- **不维护时点快照**：不写包版本表、轮次进展、历史交接。现状看代码与 CHANGELOG，历史看 git。
- **不建 archive/**：已完结的调查、任务书与草案直接删除；需要追溯时查 git 历史。
- **机制与路径优先**：文档写“谁负责、怎么流动、边界在哪”，不复制大段类型签名和默认值。
- **设计先行**：改行为前先更新对应包的 `docs/design.md`；改跨包契约或运行链路时同步本目录。
- **ADR 只追加**：新决策追加到 `architecture/decisions.md`，编号连续；已废止路线只留结论。
- 文档一律简体中文；链接用相对路径；失效链接发现即修。
