---
"@napuketto/kernel": patch
---

纯结构重构：运行时行为与公开 API 零变更，消除过瘦单文件目录、跨目录循环依赖、过度平铺与大文件。

- `utils/type-guards.ts` 合并入 `infra/type-guards.ts`；删除死垫片 `login/wait.ts`；
  `event-channel` 下沉 `infra/`；`types/` 保持纯类型声明，运行时转换独立为 `codec/`
  （补齐 `codec/index.ts`），切断 `types ↔ codec` 桥接重导出。
- `apis/msg.ts` 拆为 `apis/msg/`：`media-prep` / `media-io` / `media-contract` /
  `send-confirm` / `forward` / `ptt` / `queries` / `msg-api`（门面 ≤ 310 行）。
- `apis/group.ts` 拆为 `apis/group/`：`group`（门面）/ `group-parsers` / `group-bulletin` /
  `group-essence` / `group-notify`。
- `apis/` 按子域归组为 `msg/`、`group/`、`social/`、`media-web/`，顶层仅 `index.ts` 与
  `result.ts`；`profile-like.ts` 合并进 `profile.ts`（`ProfileLikeApi` 导出名不变）。
- `core.ts` 拆出 `core-options.ts`（选项类型）、`core-helpers.ts`（wrapperPath/appid/数据目录解析）、
  `login/qr-flow.ts`（二维码落盘与进度转发）；`core.ts` 只保留装配根与生命周期。
- `wrapper-loader.ts` 拆为 `wrapper/loader.ts`（dlopen / QQ 数据目录）+ `wrapper/lifecycle.ts`
  （engine/session 生命周期）+ `wrapper/types.ts`（共享类型），新增 `wrapper/index.ts` 统一出口。
- `login/login-connect.ts` 拆为 `login/msf-connection.ts` + `login/quick-login.ts`，
  `raceWithTimeout` 收敛到 `infra/wait.ts`。
- `infra/logging/` 收拢日志四件套与对应单测；各域测试就近归位 `__tests__/`，同模块
  `xxx.test.ts` / `xxx-api.test.ts` 合并统一命名，断言全部保留。
