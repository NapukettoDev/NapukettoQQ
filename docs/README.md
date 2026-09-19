# NapukettoQQ 文档导航

> 本目录是项目文档的唯一组织处。新对话 / 新成员按下面顺序读；根目录 `AGENTS.md`
> 是工程指南（红线 + 工作流，VS Code Copilot 自动加载）。

## 阅读顺序

1. **`AGENTS.md`**（仓库根）——工程指南：项目定位、硬性约束（许可证 / 依赖方向 / 红线）、
   工作流（check / build / changesets）、代码风格。**任何工作开始前必读**。
2. **[STATUS.md](STATUS.md)**——项目现状快照：包版本 / 协议面 / 发布与工程化状态 /
   遗留清单 / 已实测结论 / 关键环境事实。**每轮工作后刷新**，历史轮次细节不在此文件。
3. **[architecture.md](architecture.md)**——架构书（唯一）：项目定位 / 包结构与依赖方向 /
   分层原则 / 技术路线 / 核心数据流 / **ADR 决策表** / 路线图 / 红线与合规 / 工具链与 CI。
4. **对应包 `docs/design.md`**——各包模块设计书（设计先行，动代码前先更新）：
   - [`packages/kernel/docs/design.md`](../packages/kernel/docs/design.md)——事件桥 / 事件通道 /
     apis / 类型层来源 / downloadRichMedia 探测产物 / 登录超时兜底
   - [`packages/adapter/docs/design.md`](../packages/adapter/docs/design.md)——onebot11 事件链 /
     onReload / get-media / satori 媒体 / sysmsg protobuf 解码 / **kurobot 协议适配器（§8）**
   - [`packages/loader/docs/design.md`](../packages/loader/docs/design.md)——跨平台 v2 设计书
     （QQ 文件来源解耦 / wine / Docker 规划）/ IPC 模式与 OB11 容器装配（§9）/
     登录相位机与软重登（§10）
   - `apps/koishi-plugin-adapter/docs/design.md`（独立仓 submodule）
   - `apps/create-napukettoqq/docs/design.md`
   - `packages/loader/native/docs/HANDOVER-V11.md`（**闭源私有 submodule**，载具层最终交接）

## 专题文档

| 文档 | 内容 | 何时读 |
|---|---|---|
| [OPERATIONS.md](OPERATIONS.md) | 运维与实验规程：同账号双实例互斥 / koishi dev 行为 / instance-lock / OTel 噪音 | 涉及登录、停启实例、stderr 排查的实操前 |
| [KUROBOT-NOTES.md](KUROBOT-NOTES.md) | kurobot 协议适配器任务实录（KB 决策编号）+ 债务清单 | 做 kurobot 相关工作 / 消费债务前 |
| [DECISIONS.md](DECISIONS.md) | 决策史：路线演进 V1→V10 + V10 后补录（§10） | 需要理解「为什么走到今天」时 |

## archive/（已完结存档）

- [INVESTIGATION-richmedia-upload.md](archive/INVESTIGATION-richmedia-upload.md)——富媒体发送
  调查（2026-08-11~12 已全部修复落地，备查）
- [KUROBOT-PROMPT.md](archive/KUROBOT-PROMPT.md)——kurobot 任务书（2026-09-13 已执行完毕）
- [barrel-cleanup.md](archive/barrel-cleanup.md)——barrel 规范化任务提示词（已执行完毕）

## 维护约定

- **STATUS.md 是时点快照**：每轮工作收尾时刷新「项目快照 / 遗留清单」；历史轮次决策收编
  `DECISIONS.md` §10，实现细节落各包 design.md，不在 STATUS 堆积。
- **设计先行**：写代码前先更新对应包 design.md；新 ADR 编号进 architecture.md §6 表
  （编号连续不缺号；姊妹项目 KuroAdapter 的 ADR 引用需注明出处）。
- **归档而非删除**：已完结的调查 / 任务书移入 `archive/` 并在文件头加归档标注，保留全文。
- 本仓文档一律不用 emoji（存量除外）；引用失效路径发现即修。
