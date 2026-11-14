/**
 * helper/codec：OB11 消息段编解码域（从 helper/ 根拆分，DDD 重组）
 *
 * cqcode.ts（CQ 码文本 ↔ 结构化）与 segment.ts（canonical ↔ OB11 segment）
 * 是纯编解码原语，供 data.ts（批量转换枢纽）与协议 barrel 消费。
 */
export type { CqCode } from "./cqcode.js";
export {
    encodeCqCode,
    escapeCqParam,
    escapeCqText,
    parseCqMessage,
    serializeCqParts,
    unescapeCqText,
} from "./cqcode.js";
export {
    canonicalToSegment,
    cqCodeToSegment,
    segmentsToCqMessage,
    segmentToCanonical,
} from "./segment.js";
