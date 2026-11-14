/**
 * Satori 协议适配器
 * 公共面：类型 + 动作注册表 + 配置 schema + 传输装配 + 适配器。
 */

export { SatoriActionError } from "./action/base-action.js";
export type { SatoriActionDeps } from "./action/index.js";
export { createSatoriActionRegistry } from "./action/index.js";
export type { SatoriAdapterOptions } from "./adapter.js";
export { NapukettoSatoriAdapter } from "./adapter.js";
export type { SatoriApiOptions } from "./api/satori-api.js";
export { SatoriApi } from "./api/satori-api.js";
export type { SatoriEventContent, SatoriEventDeps } from "./event/translate.js";
export type { CanonicalToSatoriDeps } from "./helper/element/canonical.js";
export { canonicalToSatoriElements } from "./helper/element/canonical.js";
export type { SatoriElement } from "./helper/element/element.js";
export { parseElements, renderElements } from "./helper/element/element.js";
export {
    parseContentToCanonical,
    satoriToCanonicalElements,
} from "./helper/element/element-convert.js";
export type { SatoriToCanonicalDeps } from "./helper/element/media-convert.js";
export type { SatoriConfig } from "./helper/index.js";
export { HTTP_STATUS, satoriConfigSchema, satoriHttpStatusMap } from "./helper/index.js";
export type { AssembleSatoriTransportsOptions, SatoriTransportSet } from "./transport.js";
export { assembleSatoriTransports, toEventSignal } from "./transport.js";
export type {
    Argv,
    BidiList,
    Button,
    Channel,
    ChannelType,
    Direction,
    Emoji,
    Event,
    Friend,
    Guild,
    GuildMember,
    GuildRole,
    IdentifyBody,
    List,
    Login,
    LoginStatus,
    Message,
    MetaBody,
    Opcode,
    Order,
    ReadyBody,
    Signal,
    User,
} from "./types/index.js";
