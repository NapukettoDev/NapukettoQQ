# 任务提示词：Barrel 规范化整理

> **归档说明（2026-09-20）**：本任务已执行完毕（kernel apis/infra/types/login/bridge 与 adapter 各 api/helper barrel 均已落地）。

> 用法：在**新对话**中粘贴本文件内容作为首条消息。执行前先读 `AGENTS.md` → `docs/STATUS.md` → `docs/architecture.md`。

## 目标

系统化整理 NapukettoQQ 的 barrel（`index.ts`）体系，**降低 import 路径噪声**，让目录结构自解释、依赖方向清晰。本次是**纯结构重构**：不改业务行为、不改包对外 API（`packages/*/src/index.ts` 的导出签名）、不引入新依赖。

## 背景：2026-08-08 已完成的 DDD 重组（提交 b9f06ca）

已拆出的子域（**已有 barrel，勿重复**）：
- `kernel/src/wrapper/probe/`（index.ts，导出 `probeRuntime`）
- `adapter/src/satori/helper/element/`（index.ts，消息元素域）
- `adapter/src/onebot11/helper/codec/`（index.ts，CQ 编解码域）
- `loader/src/host/core/`（**无 barrel**——self-host.ts 是 tsdown 入口 + fallowrc manual entry，保持文件路径引用）

## 已建立的 barrel 规范（必须遵守）

1. **新子目录建 barrel**：`index.ts` 只 re-export，不写实现。
2. **跨目录引用走 barrel**：`import { x } from "./foo/index.js"`（`.js` 后缀，NodeNext 解析）。
3. **组内引用保持相对文件路径**：同目录文件互引用 `./a.js`，不绕 barrel（避免循环导入）。
4. **包根 `index.ts` 是唯一对外门面**：所有包外消费只从包根导入。
5. **类型与值分开 re-export**：`export type` 与 `export` 分列（verbatimModuleSyntax）。
6. **不在 barrel 写注释**：目录职责说明写 barrel 顶部块注释，具体逻辑注释留源码文件。

## 现状盘点（2026-08-08 探测，改动前重新核对）

### A. 缺 barrel 的目录（本次重点）

| 目录 | 文件 | 现状 | 建议 |
|---|---|---|---|
| `kernel/src/apis/` | 11 | `kernel/index.ts` 直接 `from "./apis/friend.js"` 等 10 行；`cache/group-cache.ts` 引 `../apis/group.js`；api 间互引（`msg.ts` 引 `result.ts` 等） | **建 `apis/index.ts` barrel**，`kernel/index.ts` 改引 barrel |
| `kernel/src/infra/` | 4 | 30+ 处 `import { kernelError } from "../infra/errors.js"`（apis/bridge/core/context/login/types/wrapper 全直接引） | **建 `infra/index.ts` barrel**，全量替换为 `from "./infra/index.js"` |
| `kernel/src/types/` | 3 根 + `listeners/` + `services/` 子目录 | `wrapper/*`、`login/*` 直接 `../types/wrapper.js` | **建 `types/index.ts` barrel**（services/listeners 是否子 barrel 由你判断，注意 types 树很深） |
| `kernel/src/login/` | 4 | `kernel/index.ts` 直接 `from "./login/lifecycle.js"` 等 | **建 `login/index.ts` barrel** |
| `kernel/src/bridge/` | 2 | `kernel/index.ts` 直接引 | **建 `bridge/index.ts` barrel** |
| `adapter/onebot11/action/` | index.ts 是注册函数非 barrel | `error-map.ts`/`resolve-uid.ts` 平铺，action 分组引 `../error-map.js`（40+ 处） | **建真正 barrel**：re-export 全部 action 类 + error-map + resolve-uid + Ob11ActionDeps + createOb11ActionRegistry |
| `adapter/onebot11/api/`、`adapter/satori/api/` | 单文件 | 外部直接引 | **建 `index.ts` barrel**（单文件也建，统一入口） |
| `adapter/satori/helper/` | config/error/ids/translate 平铺 | action/event/adapter/transport 直接引 `../helper/xxx.js` | **建 `helper/index.ts` barrel**（translate 是枢纽，注意与 element/ 子目录关系） |
| `loader/src/host/` | env/types/util/load-config/msg-log | `core/` 内引 `../env.js` 等 | **建 `host/index.ts` barrel**？——**先论证**：host 是 tsdown 内部 bundle，无外部消费者，barrel 收益低；倾向不建，保持 `../env.js` |

### B. 已达标目录（勿动）

`kernel/cache/`、`kernel/wrapper/probe/`、`adapter/core/`、`adapter/onebot11/event/`、`adapter/onebot11/helper/`（含 codec 子目录）、`adapter/satori/event/`、`adapter/satori/types/`、`adapter/satori/action/`、`adapter/satori/helper/element/`。

### C. 已知红线（违反 = 错误）

1. **`kernel/wrapper/` 根 6 文件**（wrapper-loader/adapters/config/version、session-resolver、qq-data-path）**不建 barrel**——它们是装配层，被 `kernel/index.ts`、`context.ts`、`core.ts`、`login/*` 直接引用，且 `wrapper/` 已有 `probe/` 子目录，根 barrel 会让 `wrapper/index.ts` 与 `wrapper/probe/index.ts` 语义重叠。
2. **`loader/src/host/core/self-host.ts` 不移动、不建 barrel**（tsdown 入口 + fallowrc entry）。
3. **`adapter/satori/types/`** 已是 `export *` 风格（api/event/resource），保持。
4. 不改 `packages/*/src/index.ts` 对外导出签名（barrel 只是内部组织手段）。

## 工作流

1. **先核对**：用 `file_search`/`list_dir` 核对上述盘点是否与当前工作区一致（可能已有变更）。
2. **设计先行**：每建一个 barrel 前，先想清楚「这个目录的公共面是什么、谁消费它、有没有循环导入风险」。涉及目录关系判断时先写进对应包 `docs/design.md`。
3. **一个目录一个目录做**：每完成一个 barrel，跑 `pnpm check` 验证再继续。顺序建议：`infra`（最底层，被引用最多）→ `types` → `login` → `bridge` → `apis` → `onebot11/action` → 各 `api/` → `satori/helper`。
4. **替换引用**：barrel 建好后，用 `grep_search` 找该目录的所有直接引用，逐个改为 `from "./目录/index.js"`（相对路径层级注意：`apis/*.ts` 引 `../infra/index.js`，`kernel/index.ts` 引 `./apis/index.js`）。
5. **验证**：`pnpm check`（biome + tsc）全绿 + `pnpm test`（59 用例）全绿 + `pnpm -r build` 全包构建通过 + `pnpm dlx fallow` 确认 dead files/exports 仍为 0（新 barrel 若报 unused re-export，判断是否真消费方——是则加 `.fallowrc.jsonc` 的 `ignoreFindings`，注释说明原因，参考 codec/element 先例）。
6. **变更集 + 提交**：按 Changesets 流程，本次是纯结构重构（无行为变化）——**记 `patch`，但注意是内部组织变更**，若你认为不值得发版可只写 changeset 不消费。提交信息用简体中文，格式参考历史（`refactor: ...`）。

## 交付物

- 每个新建 barrel：`index.ts`（顶部块注释说明目录职责）
- 全量引用替换（`grep_search` 确认无 `from "./xxx.js"` 直指已建 barrel 目录的残留，**组内引用除外**）
- `pnpm check` / `pnpm test` / `pnpm -r build` / `pnpm dlx fallow` 全绿
- 一个 changeset（patch）
- 总结：列出建了哪些 barrel、改了哪些文件、验证结果
