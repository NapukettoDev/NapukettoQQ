/**
 * adapter core 框架入口（ADR-013，可被第三方复用）
 */

export { ActionRegistry } from "./action-registry.js";
export type { ProtocolAdapterLike } from "./adapter-registry.js";
export { AdapterRegistry } from "./adapter-registry.js";
export type { ActionResult, ErrorCodeMap } from "./base-action.js";
export { BaseAction } from "./base-action.js";
export type { ProtocolHooks } from "./base-protocol-adapter.js";
export { BaseProtocolAdapter } from "./base-protocol-adapter.js";
export { ProtocolConfig } from "./config.js";
export { ensureSilk } from "./media.js";
export {
    collectStrings,
    decodeProtoTree,
    decodeText,
    extractSysMsgEnvelope,
    firstField,
    getChildren,
    narrowSysMsgBlobs,
    nodeAt,
    type SysMsgEnvelope,
    type SysMsgField,
    type SysMsgKindRule,
    type SysMsgRecognition,
    textOf,
    toHex,
    varintAt,
    varintOf,
    varintToNumber,
} from "./sysmsg.js";
