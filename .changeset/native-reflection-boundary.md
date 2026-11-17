---
"@napuketto/kernel": minor
"@napuketto/adapter": minor
"@napuketto/loader": patch
"@napuketto/network": patch
"@napuketto/media": patch
"@napuketto/cli": patch
"create-napukettoqq": patch
---

二阶段类型安全清零：原生反射边界（wrapper / loader / network）与全仓残余断言改用运行时类型守卫。

- kernel：`type-guards` 扩展（`isCallable` / `getOwnProp` / `hasMethodSurface` / `getErrorCode` 等），新增 `wrapper/wrapper-guards`；`wrapper-loader`、`session-resolver`、`probe/**` 零断言；`GroupMember` / `EssenceMsgItem` 的非保证字段改为可选并在守卫中逐字段校验；`login-bridge`、`event-channel`、`msg` / `recent-contact` / `profile`、日志与配置解析同步清零。
- loader：新增本地 `type-guards` / `module-guards`，动态 `import()` 结果与 IPC 反射调用全部运行时校验；`CoreContextLike` / `KernelServices` 补齐精确结构，删除下游强转；diagnostic `sessionCall` 拦截 `onLine` / `wifiphoto` 危险方法。
- network / media：`JSON.parse` 与原生 server 收窄改守卫；ffprobe 输出安全构造。
- adapter / apps：`buddy-req` / essence / milky / kurobot / OB11 请求分发与 CLI 配置解析改用守卫，畸形载荷安全降级。
