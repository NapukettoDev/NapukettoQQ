---
"@napuketto/kernel": minor
"@napuketto/adapter": patch
"@napuketto/cli": patch
---

运行时边界硬化（审计复核后的真实缺陷）：

- kernel：`DoubtFriendRequestInfo.uin` 改为可选——uid 无法解析为正整数 uin 时不再产出
  NaN（JSON 序列化会变 null），`get_doubt_friends_add_request` 不再返回假 uin。
- kernel：`createSession` 的 `new Session` 与 `initSession` 的 `session.init` 增加调用点
  可调用性检查，wrapper 导出漂移时抛 `KernelError` 而非裸 TypeError；`create()` 返回值
  同样过 session 方法面守卫。
- adapter：`ProtocolConfigInput` 去掉 `| Record<string, unknown>` 逃生舱，避免任意对象
  绕过 `Partial<TConfig>` 约束（别的协议的 ConfigBase 也能塞进来）。
- cli：`config validate` 对非空协议段执行与 loader 装配同 schema 的 zod 校验（空段 =
  不启用，跳过），消除「校验通过但启动 exit 78」的假承诺。
