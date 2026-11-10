/**
 * adapter core 框架入口（ADR-013，可被第三方复用）
 */

export { ActionRegistry } from "./framework/action-registry.js";
export type { ProtocolAdapterLike } from "./framework/adapter-registry.js";
export { AdapterRegistry } from "./framework/adapter-registry.js";
export type { ActionResult, ErrorCodeMap } from "./framework/base-action.js";
export { BaseAction } from "./framework/base-action.js";
export type { ProtocolHooks } from "./framework/base-protocol-adapter.js";
export { BaseProtocolAdapter } from "./framework/base-protocol-adapter.js";
export { ProtocolConfig } from "./framework/config.js";
export { ensureSilk, type PreparedVideoElements, prepareVideoElements } from "./shared/media.js";
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
} from "./shared/sysmsg.js";
