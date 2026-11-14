---
"@napuketto/adapter": minor
---

adapter core 框架收拢（结构重构会话 1/5）：

- `ProtocolHooks` 泛型化（`ProtocolHooks<TConfig>`）：onStart/onReload 强类型透传协议
  配置，删除四个协议 adapter 内的 `config as XConfig` 强转；默认类型参数保持
  `ProtocolHooks` 旧用法可编译。
- 新增动作执行内核 `runAction`（`@napuketto/adapter/core` 导出）：OB11 / Milky /
  Satori 三套动作基类共用 safeParse + `isKernelError` 统一映射骨架，校验失败 retcode、
  消息模板与结果包装参数化。行为收口一处：非 KernelError 的「带 code 普通 Error」不再
  按 code 映射，统一落映射表 UNKNOWN 兜底（此前 OB11 为形状嗅探）。
- 删除死代码：`AdapterRegistry` / `ProtocolAdapterLike` 不再从 `@napuketto/adapter/core`
  导出（装配方直接持有各协议适配器，cli/loader 无引用）；`satori/action/registry.ts`
  空壳别名文件删除，`SatoriActionRegistry` 类型并入 `satori/action/index.ts` 导出。
- 跨协议重复原语收拢 `core/shared`：`toUin` / `toUinString`（OB11 / Milky / Satori 共
  5 处本地实现收敛）、`hasGrayTip`（OB11 / Milky）、`EssenceListSync`（精华列表缓存 +
  串行链，OB11 / Milky adapter 共用）、`findFirstMatch`（milky api 与 satori action 的
  通知/申请查找骨架）。
