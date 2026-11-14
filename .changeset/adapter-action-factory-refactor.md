---
"@napuketto/adapter": minor
---

重构 adapter 动作体系与目录边界（动作名、zod schema、错误码映射与事件格式均不变）：

- 动作从类样板（`class XxxAction extends BaseXxxAction`）改为 `{ name, schema, handle }`
  声明式对象，由各协议运行时工厂 `defineOb11Action` / `defineMilkyAction` /
  `defineSatoriAction` 组装（闭包依赖、统一信封与错误映射）；动作注册表改为按领域
  工厂遍历注册。
- `@napuketto/adapter/core` 协议中立化：OB11 专属的 `BaseAction` / `ActionResult`
  信封移入 `./onebot11` 子路径内部；`ProtocolConfig` 空壳删除，配置基类直接用 kernel
  `ConfigBase`（从 `./core` 重导出）；`createHttpServerSchema` / `createWsServerSchema`
  合并为 `createServerSchema`。
- QQ NT 共享原语（sysmsg 解码、grayTip、uid↔uin、媒体准备、RawMessage 规范化与
  `toUnixSeconds`）移至包内 `src/shared/`，不再从 `@napuketto/adapter/core` 导出；
  `./core` 只保留通用适配器框架（`runAction` / `ActionRegistry` /
  `BaseProtocolAdapter` / `ProtocolHooks` / `ConfigBase`）。
- 收链路异步事件翻译统一挂 `.catch` 错误边界（单条/整批丢弃 + warn 留痕），
  单条消息回填异常不再产生 Unhandled Rejection。
