/**
 * OneBot 11 协议适配器（当前主战场）
 * 公共面：类型 + 动作注册表 + 配置 schema + 翻译层（adapter.ts 于 打通 kernel 事件后接入）。
 */

export type { AtAllRemainInfo, Ob11ActionDeps } from "./action/index.js";
export { createOb11ActionRegistry, ob11ErrorCodeMap } from "./action/index.js";
export type { OneBot11AdapterOptions } from "./adapter.js";
export { NapukettoOneBot11Adapter } from "./adapter.js";
export type { OneBotApiOptions, OneBotSystemOptions } from "./api/one-bot-api.js";
export { OneBotApi } from "./api/one-bot-api.js";
export type {
    OB11BaseEvent,
    OB11Event,
    OB11FriendRequestEvent,
    OB11GroupMessageEvent,
    OB11GroupRequestEvent,
    OB11HeartbeatMetaEvent,
    OB11LifecycleMetaEvent,
    OB11MessageEvent,
    OB11MetaEvent,
    OB11NoticeEvent,
    OB11PostType,
    OB11PrivateMessageEvent,
    OB11RequestEvent,
    OB11Status,
} from "./event/index.js";
export type { CqCode, OB11Config } from "./helper/index.js";
export {
    canonicalToCqMessage,
    canonicalToSegments,
    cqMessageToCanonical,
    cqMessageToSegments,
    encodeCqCode,
    escapeCqParam,
    escapeCqText,
    ob11ConfigSchema,
    parseCqMessage,
    segmentsToCanonical,
    segmentsToCqMessage,
    serializeCqParts,
    unescapeCqText,
} from "./helper/index.js";
export { MessageUnique } from "./helper/message-unique.js";
export type { AssembleOb11TransportsOptions, Ob11TransportSet } from "./transport.js";
export { assembleOb11Transports } from "./transport.js";
export type {
    CurrentTalkative,
    FriendInfo,
    GroupHonorInfo,
    GroupInfo,
    GroupMemberInfo,
    HonorMember,
    LoginInfo,
    OB11Message,
    OB11MessageInfo,
    OB11MessageSegment,
    OB11Return,
    Sender,
    Sex,
    StrangerInfo,
    VersionInfo,
} from "./types/index.js";
