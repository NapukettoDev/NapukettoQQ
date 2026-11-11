# NapukettoQQ 文档

> 代码是唯一事实源。本目录只解释现行机制、边界与操作；字段默认值、动作名、类型签名与
> 包版本以源码和 `package.json` 为准。文档与代码冲突时，以代码为准并顺手修文档。

## 我该读哪篇

读者：**A** = 用户/运维，**B** = 贡献者，**C** = AI 代理。

| 读者 | 任务 | 入口 |
|---|---|---|
| A | 安装并跑起第一个机器人 | [根 README 快速开始](../README.md#快速开始) → [配置](guides/configuration.md) |
| A | Docker 部署 | [Docker 指南](guides/docker.md) |
| A | 接 Koishi / 第三方客户端 | [OneBot 11](protocols/onebot11.md) · [Satori](protocols/satori.md) · [KuroBot](protocols/kurobot.md) · [Milky](protocols/milky.md) |
| A | 启动失败、掉线、端口冲突 | [运维与排障](guides/operations.md) |
| B | 本地开发、提交、changeset | [开发指南](guides/development.md) |
| B | 改某个包 | 该包 `docs/design.md`（实测细节在同级 `docs/evidence.md`） |
| B/C | 架构、启动链、历史取舍 | [架构总览](architecture/overview.md) · [运行链路](architecture/runtime.md) · [ADR](architecture/decisions.md) |
| B | Linux ELF 宿主与依赖 | [Linux 原生宿主](architecture/linux-native-host.md)（探针见 [evidence](architecture/linux-native-host-evidence.md)） |
| C | 固定入口链 | [AGENTS.md](../AGENTS.md) → 本页 → [overview](architecture/overview.md) → [runtime](architecture/runtime.md) → 包 design |

## 文档地图

| 文档 | 职责 | 何时更新 |
|---|---|---|
| [architecture/overview.md](architecture/overview.md) | 包拓扑、依赖方向、进程模型、分层红线 | 新增包或改变包间依赖 |
| [architecture/runtime.md](architecture/runtime.md) | 启停生命周期、登录/session、数据流、IPC、多账号 | 改 supervisor 或生命周期 |
| [architecture/decisions.md](architecture/decisions.md) | 仍约束代码的 ADR 与已废止路线结论 | 发生重大技术选型变更 |
| [architecture/linux-native-host.md](architecture/linux-native-host.md) | Linux ELF 宿主机制、stub、最低依赖、arm64 现状 | 改 ELF 加载器或 stub 符号 |
| [guides/configuration.md](guides/configuration.md) | `napuketto.toml` 结构、路径解析、环境变量 | 顶层配置 schema 变更 |
| [guides/operations.md](guides/operations.md) | 停启、状态、日志、退出码、常见故障 | 新增高频运维故障模式 |
| [guides/docker.md](guides/docker.md) | 官方镜像双变体、compose、卷、端口、备份 | Dockerfile 或镜像变体变更 |
| [guides/development.md](guides/development.md) | 本地环境、构建顺序、测试、CI、代码风格 | 构建流或本地调试方式变更 |
| [protocols/onebot11.md](protocols/onebot11.md) | OB11 配置、动作/事件面、ID 映射、差异 | 增改 OB11 行为 |
| [protocols/satori.md](protocols/satori.md) | Satori 传输、动作/事件、元素编解码 | 增改 Satori 行为 |
| [protocols/kurobot.md](protocols/kurobot.md) | KuroBridge WS 客户端、映射、限制 | 增改 KuroBot 行为 |
| [protocols/milky.md](protocols/milky.md) | Milky 配置、能力面、已知差异 | Milky 接口实现变更 |

包内设计书与 evidence：

- [kernel design](../packages/kernel/docs/design.md) · [evidence](../packages/kernel/docs/evidence.md)
- [adapter design](../packages/adapter/docs/design.md) · [evidence](../packages/adapter/docs/evidence.md)
- [loader design](../packages/loader/docs/design.md) · [evidence](../packages/loader/docs/evidence.md)
- [create design](../apps/napuketto-create/docs/design.md)
- [cli design](../apps/cli/docs/design.md) · [network design](../packages/network/docs/design.md) ·
  [media design](../packages/media/docs/design.md)

## 写作规范（强制）

四类文档各用固定骨架，首屏 H1 下必须是 `>` 引用块（≤3 行）：解决什么问题、给谁看、源码在哪。

- **`design.md`**：`## 核心机制`（拓扑/数据流/状态机）→ 跨包契约（接口边界与错误传播，
  不抄签名）→ 关键取舍与不变量（改代码不能破的红线）；小包可合并小节。实测链接 `./evidence.md`。
- **`evidence.md`**：`## 探针与复现命令` → `## 字段样本与边界表现`。只放逆向/实测证据，
  不是 API 契约；严禁 RVA/Offset/内存地址，禁止日期与阶段进度。
- **`protocols/*.md`**：`## 配置方式`（必填 + 高频项，全量字段指源码 schema）→ 按协议组织
  传输、能力速查、事件与差异；表头注明源码目录，不写汇总数字。
- **`guides/*.md`**：`## 操作步骤`（仅此处允许 `1. 2. 3.`）→ `## 验证与常见排障`；
  参考型指南（如开发指南）可只保留命令与说明。

格式红线：

1. 标题不写手工编号（`## 1.`、`### 9.12`、`Stage 3b`）；最多到 H3。
2. 除 `decisions.md` 外不写日期、Stage、进度标记、PR/issue 编号；历史交 Git。
3. 非表格、非 URL 行 ≤120 字符；表格单元格不写长句，不放代码块。
4. 单段 JSON >15 行必须进 `evidence.md`；正文只留最小示意。
5. 固定术语：`wrapper.node`、Linux 原生宿主、`napuketto.toml`、内嵌协议段、`@napuketto/*`；
   用户变量 `NAPKETTO_*`，loader 内部变量 `NAPUTO_*`（以源码为准）。

## 维护红线

- 改行为前先改对应包 `design.md`；跨包契约变化同步本目录。
- 严禁向 `design.md` 追加带日期的进度记录或大段实测 JSON；证据一律进同级 `evidence.md`。
- 不维护时点快照：不写版本表、轮次进展、历史交接；不建 `archive/`；过期即删，追溯查 Git。
- ADR 只追加编号，被替代的条目保留并注明替代者。
- 增删文档文件时同步本页路由；提交前跑 `pnpm check:docs`。
