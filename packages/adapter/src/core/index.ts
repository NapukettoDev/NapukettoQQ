/**
 * adapter core 框架入口（协议中立）
 *
 * 只承载可被第三方复用的适配器骨架：动作执行内核（runAction）、动作注册表、
 * 适配器生命周期与配置基类。QQ NT 共享原语（sysmsg 解码、grayTip、uid↔uin、
 * 媒体准备、RawMessage 规范化等）在包内 `src/shared/`，不对外导出；协议面
 * 一律走 ./onebot11 / ./satori / ./kurobot / ./milky 子路径。
 */

export { ConfigBase } from "@napuketto/kernel";
export type { ActionKernelSpec, ActionOutcome, ErrorCodeMap } from "./framework/action-kernel.js";
export { runAction } from "./framework/action-kernel.js";
export { ActionRegistry } from "./framework/action-registry.js";
export type { ProtocolHooks } from "./framework/base-protocol-adapter.js";
export { BaseProtocolAdapter } from "./framework/base-protocol-adapter.js";
