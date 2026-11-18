/**
 * adapter core 框架入口（协议中立）
 *
 * 只承载可被第三方复用的适配器骨架：动作执行内核（runAction）、动作注册表、
 * 适配器生命周期与配置基类。QQ NT 共享原语（sysmsg 解码、grayTip、uid↔uin、
 * 媒体准备、RawMessage 规范化等）在包内 `src/shared/`，不对外导出；协议面
 * 一律走 ./onebot11 / ./satori / ./kurobot / ./milky 子路径。
 *
 * 配置兼容：`ProtocolConfig` 是 `ConfigBase` 的历史别名（loader 动态 import
 * 仍按该名字构造），保留导出避免运行期断链。
 */

export type { ConfigFormat, ConfigOptions, ConfigSchema } from "@napuketto/kernel";
export {
    ConfigBase,
    /** @deprecated 使用 `ConfigBase`（历史别名，保留以兼容 loader 动态 import 与外部插件） */
    ConfigBase as ProtocolConfig,
} from "@napuketto/kernel";
export type { ActionKernelSpec, ActionOutcome, ErrorCodeMap } from "./framework/action-kernel.js";
export { runAction } from "./framework/action-kernel.js";
export { ActionRegistry } from "./framework/action-registry.js";
export type { TokenAuthOptions } from "./framework/auth.js";
export { BEARER_PREFIX, createTokenAuthorize, matchTokenCredential } from "./framework/auth.js";
export type { ProtocolHooks } from "./framework/base-protocol-adapter.js";
export { BaseProtocolAdapter, resolveProtocolConfig } from "./framework/base-protocol-adapter.js";
export { createServerSchema } from "./framework/transport-schema.js";
