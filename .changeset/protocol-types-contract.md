---
"@napuketto/loader": patch
---

消除协议构造入参的类型黑洞（零运行时变更、零对外 API 变化）：
`runtime/protocol-types.ts` 不再用 `Record<string, unknown>` 描述 adapter 构造器入参，
改为逐协议的 `*AdapterOptionsLike` 结构接口（字段名 = adapter 公开选项名，值类型 =
loader 侧最小结构面）——loader 自己的装配对象字面量重新受多余属性检查约束。

新增纯类型对拍测试 `tests/host/runtime/protocol-types.test-d.ts`，随根 `pnpm check`
（`tsc --noEmit`）执行：模块导出键 ⊆ adapter 实际导出、loader 入参键 ⊆ adapter 选项键、
adapter 必填项 ⊆ loader 入参必填项、原始值字段类型兼容。adapter 侧重命名或新增必填构造项
时 `tsc` 直接报错，不再等运行期启用对应协议才暴露；测试取 adapter 源码类型（非 `dist`），
不依赖构建顺序。

保持编译期 0 workspace 依赖：不新增任何 workspace 依赖，`src/` 侧也没有 adapter 类型引用
（结构接口手写 + 测试目录类型对拍，对拍只在 `pnpm check` 里跑，不进入包依赖图）。另把
`KernelServices.logger` 由 `unknown` 收紧为 `LoggerLike | undefined`（与
`kernel.createLogger` 实际返回一致）。
