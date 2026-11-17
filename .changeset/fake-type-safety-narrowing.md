---
"@napuketto/adapter": patch
"@napuketto/cli": patch
"@napuketto/kernel": patch
---

清理全仓「虚假类型安全」：以类型守卫 / 可辨识联合 / 泛型容器替换 `as unknown as`、
`as never` 与整值强转（公共 API 签名与返回字段名零破坏）。

- kernel：新增 `utils/type-guards.ts`（`isRecord` / `has*Prop` / `requireKernelService`）
  并对外导出；`NodeIQQNTWrapperSession.get*Service()` 按各 Service 接口精确收窄
  （`NodeIKernel*Service | null`），14 处会话服务取用改走 `requireKernelService`
  校验空句柄与方法面；`LoginProgress` / `MilkyActionResult` / `ActionResult` 重构为
  可辨识联合（属性名不变）；群详情 / 成员 / 通知 / 群文件 / 精华消息 / 登录服务
  全部走元素级守卫与 `isRecord` 收窄；`GroupCache` 的 in-flight 去重按返回类型
  拆分为三个精确容器；`fetchQunJson` 响应体先收窄再取字段；cookies 超时/网络
  失败统一抛 `kernelError`（`TIMEOUT` / `UNKNOWN`）。
- adapter：OB11 入站 segment 新增 `isOB11MessageSegment` / `parseOB11MessageSegments`
  严格校验（`[null]`、缺必填字段、未知类型均抛 `INVALID_PARAM`），
  `canonicalToSegment` / `segmentToCanonical` 改为可辨识联合 `switch`；Milky 发送段
  以 `RawOutgoingSegment` + 字段守卫替代 `ZodType` 强转，已知段缺字段抛
  `INVALID_PARAM`、forward 内嵌段逐项校验；`forEachRawMessage` 逐条过
  `isRawMessage`；Satori WS 信令与 `has*` 守卫收窄。
- cli：`runtime.json` / `supervisor.json` 读取改为严格形状守卫（损坏/旧格式返回
  null）；二维码标记行与 `CliConfig → TOML` 显式映射，移除整值强转与
  `NodeJS.ErrnoException` 强转。
