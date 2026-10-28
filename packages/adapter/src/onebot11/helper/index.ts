/**
 * OneBot 11 helper：配置 schema（ADR-012）+ 翻译层（canonical ↔ OB11，ADR-008）
 */

export type { CqCode } from "./codec/cqcode.js";
export {
    encodeCqCode,
    escapeCqParam,
    escapeCqText,
    parseCqMessage,
    serializeCqParts,
    unescapeCqText,
} from "./codec/cqcode.js";
export { segmentsToCqMessage } from "./codec/segment.js";
export type { OB11Config } from "./config.js";
export { ob11ConfigSchema } from "./config.js";
export {
    applyReceiveContext,
    applySendContext,
    canonicalToCqMessage,
    canonicalToSegments,
    collectReceiveNeeds,
    cqMessageToCanonical,
    cqMessageToSegments,
    type GroupSenderRole,
    type ReceiveTranslateContext,
    type SendTranslateContext,
    segmentsToCanonical,
} from "./data.js";
export { toOb11MessageInfo } from "./message-info.js";
export { MessageUnique } from "./message-unique.js";
export {
    collectGrayTipUids,
    hasGrayTip,
    type NoticeTranslateContext,
    toOb11NoticeEvent,
} from "./notice.js";
export {
    isBuddyReqLike,
    narrowBuddyReqs,
    type RequestTranslateContext,
    toOb11FriendRequestEvent,
    toOb11GroupRequestEvent,
} from "./request.js";
export { toOb11GroupInfo, toOb11GroupMemberInfo } from "./translate.js";
