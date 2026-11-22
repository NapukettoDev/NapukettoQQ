/**
 * Milky 消息段 ↔ canonical 元素转换（纯函数）
 *
 * 接收方向：canonical → IncomingSegment（规范 14 种中映射 12 种；market_face /
 * markdown 无 canonical 对应（MFACE/MARKDOWN 原始元素形状未探测），unknown 一律
 * 跳过——规范兼容性要求「数组中未知项跳过」）。forward 接收段不经 canonical：
 * kernel 无 MULTI_FORWARD 分支，adapter 从 RawMessage 提取 resId 后经
 * incomingForwardSegment + ctx 注入。
 * 发送方向：OutgoingSegment → canonical（10 种全映射；forward 顶层段不走本转换器，
 * 由 sendMilkyMessage 分流到组装链——本转换器内 forward 报错只拦截混发/嵌套）。
 *
 * 入站载荷是不可信输入：入口 zod 只保证 `{type, data}` 形状，字段级类型由本文件的
 * `hasStringProp` / `hasNumberProp` 守卫逐项校验（缺失即 INVALID_PARAM），
 * 不再把入口值谎称成完整 OutgoingSegment 或 `seg.data.xxx` 盲取。
 */
import type { CanonicalElement } from "@napuketto/kernel";
import { hasNumberProp, hasStringProp, isRecord, kernelError } from "@napuketto/kernel";
import type { IncomingSegment, OutgoingSegment } from "../../types.js";

/** 发送段的最小形状（入口只保证 type 为 string、data 为对象）。 */
export interface RawOutgoingSegment {
    type: string;
    data: Record<string, unknown>;
}

/** 发送段最小形状守卫（type + data 对象）。 */
export function isRawOutgoingSegment(val: unknown): val is RawOutgoingSegment {
    return isRecord(val) && hasStringProp(val, "type") && isRecord(val["data"]);
}

/** reply 段回填元信息（广播/action 路径异步取得，翻译纯函数消费）。 */
export interface ReplyMeta {
    messageSeq: number;
    senderId: number;
    time: number;
}

/** 接收段转换上下文（enrichment 产物）。 */
export interface ReceiveSegmentContext {
    /** at uid → uin（mention.user_id 需要 uin；缺省不转换，转换失败跳过该段）。 */
    uidToUin?: Map<string, string>;
    /** reply NT msgId → 引用消息元信息（回填 message_seq/sender_id/time）。 */
    replyMeta?: Map<string, ReplyMeta>;
}

/** uin 字符串 → Milky user_id（非有限正数 = 转换失败）。 */
function toUserId(uin: string): number | undefined {
    const n = Number(uin);
    return Number.isFinite(n) && n >= 10001 ? n : undefined;
}

/** canonical 元素 → IncomingSegment 列表（unknown / 转换失败段跳过）。 */
export function canonicalToIncomingSegments(
    elements: CanonicalElement[],
    ctx: ReceiveSegmentContext = {},
): IncomingSegment[] {
    const out: IncomingSegment[] = [];
    for (const el of elements) {
        const seg = canonicalToIncomingSegment(el, ctx);
        if (seg !== null) {
            out.push(seg);
        }
    }
    return out;
}

/** canonical image → image 段（resource_id = 本地路径优先，url 兜底）。 */
function imageToIncoming(el: Extract<CanonicalElement, { type: "image" }>): IncomingSegment {
    return {
        type: "image",
        data: {
            resource_id: el.path !== "" ? el.path : (el.url ?? ""),
            temp_url: el.url ?? "",
            width: el.size?.width ?? 0,
            height: el.size?.height ?? 0,
            summary: "",
            sub_type: "normal",
        },
    };
}

/** canonical voice → record 段。 */
function voiceToIncoming(el: Extract<CanonicalElement, { type: "voice" }>): IncomingSegment {
    return {
        type: "record",
        data: {
            resource_id: el.path !== "" ? el.path : (el.url ?? ""),
            temp_url: el.url ?? "",
            duration: el.durationMs !== undefined ? Math.round(el.durationMs / 1000) : 0,
        },
    };
}

/** canonical video → video 段。 */
function videoToIncoming(el: Extract<CanonicalElement, { type: "video" }>): IncomingSegment {
    return {
        type: "video",
        data: {
            resource_id: el.path !== "" ? el.path : (el.url ?? ""),
            temp_url: el.url ?? "",
            width: el.width ?? 0,
            height: el.height ?? 0,
            duration: el.durationSec ?? 0,
        },
    };
}

/**
 * canonical → IncomingSegment 单元素分发（可辨识联合 switch）。
 * 未映射类型（unknown / forward / 规范无对应）→ null（规范兼容性要求跳过）。
 *
 * 按「简单段 / 媒体与载荷段」拆两级：一级 switch 只分派，二级各管一类，
 * 单函数分支数保持低位（fallow 复杂度门禁）。
 */
function canonicalToIncomingSegment(
    el: CanonicalElement,
    ctx: ReceiveSegmentContext,
): IncomingSegment | null {
    switch (el.type) {
        case "at":
            return atToIncoming(el, ctx);
        case "reply":
            return replyToIncoming(el, ctx);
        case "text":
        case "face":
        case "file":
            return simpleIncoming(el);
        default:
            return mediaOrPayloadIncoming(el);
    }
}

/** 无需上下文的直映射元素子集。 */
type SimpleIncomingElement = Extract<CanonicalElement, { type: "text" | "face" | "file" }>;

/** text / face / file 直映射。 */
function simpleIncoming(el: SimpleIncomingElement): IncomingSegment {
    switch (el.type) {
        case "text":
            return { type: "text", data: { text: el.text } };
        case "face":
            return { type: "face", data: { face_id: el.id, is_large: false } };
        case "file":
            return fileToIncoming(el);
    }
}

/** 媒体段（image / voice / video）与载荷段（json / xml）映射；其余返回 null。 */
function mediaOrPayloadIncoming(el: CanonicalElement): IncomingSegment | null {
    switch (el.type) {
        case "image":
            return imageToIncoming(el);
        case "voice":
            return voiceToIncoming(el);
        case "video":
            return videoToIncoming(el);
        case "json":
            return {
                type: "light_app",
                data: { app_name: parseAppName(el.raw), json_payload: rawToPayload(el.raw) },
            };
        case "xml":
            return { type: "xml", data: { service_id: 0, xml_payload: rawToPayload(el.raw) } };
        default:
            // unknown / forward：canonical 不承载，跳过（规范兼容性要求）
            return null;
    }
}

/** canonical at → mention / mention_all（uid→uin 失败跳过该段）。 */
function atToIncoming(
    el: Extract<CanonicalElement, { type: "at" }>,
    ctx: ReceiveSegmentContext,
): IncomingSegment | null {
    if (el.target === "all") {
        return { type: "mention_all", data: {} };
    }
    const uin = ctx.uidToUin?.get(el.target) ?? el.target;
    const userId = toUserId(uin);
    if (userId === undefined) {
        return null;
    }
    return { type: "mention", data: { user_id: userId, name: el.display ?? "" } };
}

/** canonical reply → reply 段（引用元信息经 ctx 回填，未命中全 0 兜底）。 */
function replyToIncoming(
    el: Extract<CanonicalElement, { type: "reply" }>,
    ctx: ReceiveSegmentContext,
): IncomingSegment {
    const meta = ctx.replyMeta?.get(el.messageId);
    return {
        type: "reply",
        data: {
            message_seq: meta?.messageSeq ?? 0,
            sender_id: meta?.senderId ?? 0,
            sender_name: null,
            time: meta?.time ?? 0,
            segments: [],
        },
    };
}

/** canonical file → file 段。 */
function fileToIncoming(el: Extract<CanonicalElement, { type: "file" }>): IncomingSegment {
    return {
        type: "file",
        data: {
            file_id: el.path,
            file_name: el.name ?? "",
            file_size: el.size ?? 0,
        },
    };
}

/**
 * 合并转发 → forward 段。
 * 接收方向 canonical 不承载 MULTI_FORWARD（kernel toCanonicalElement 无此分支），
 * 由 adapter 从 RawMessage 提取 resId 后调用本函数经 ctx 注入（翻译保持纯函数）。
 * title 取 NT fileName（转发卡片标题语义）。
 */
export function incomingForwardSegment(resId: string, title: string): IncomingSegment {
    return {
        type: "forward",
        data: {
            forward_id: resId,
            title,
            preview: [],
            summary: "",
        },
    };
}

/** json 载荷 → 小程序名（spec app_name：JSON 顶层 app 字段，取不到空串）。 */
function parseAppName(raw: unknown): string {
    let obj: unknown = raw;
    if (typeof raw === "string") {
        try {
            obj = JSON.parse(raw);
        } catch {
            return "";
        }
    }
    if (!isRecord(obj)) {
        return "";
    }
    const app = obj["app"];
    return typeof app === "string" ? app : "";
}

/** canonical json/xml raw → 字符串载荷（字符串原样，其余 JSON 序列化）。 */
function rawToPayload(raw: unknown): string {
    if (typeof raw === "string") {
        return raw;
    }
    try {
        return JSON.stringify(raw) ?? "";
    } catch {
        return "";
    }
}

/**
 * OutgoingSegment 数组 → canonical 元素（同步映射；媒体 URI 解析与 at uin→uid
 * 由调用方在返回值上继续处理）。
 *
 * 入参兼容 `RawOutgoingSegment`（HTTP 载荷只保证 {type,data} 形状）：已知类型的
 * 必填字段逐项守卫，缺失/类型错误立即抛 INVALID_PARAM；未知 type 按协议跳过。
 * forward 在此报错：顶层 forward 已由 sendMilkyMessage 分流到组装链（message.ts），
 * 命中本分支 = forward 与其他段混发漏网或嵌套 forward（组装链内逐项转换经过此处）
 * ——均显式拒绝。
 */
export function outgoingSegmentsToCanonical(
    segments: readonly (OutgoingSegment | RawOutgoingSegment)[],
): {
    elements: CanonicalElement[];
    atUins: string[];
    replySeqs: number[];
} {
    const elements: CanonicalElement[] = [];
    const atUins: string[] = [];
    const replySeqs: number[] = [];
    for (const seg of segments) {
        const converted = outgoingSegmentToCanonical(seg);
        if (converted === null) {
            continue;
        }
        elements.push(converted.element);
        if (converted.atUin !== undefined) {
            atUins.push(converted.atUin);
        }
        if (converted.replySeq !== undefined) {
            replySeqs.push(converted.replySeq);
        }
    }
    return { elements, atUins, replySeqs };
}

/** 单段转换结果（附带回填所需的 at uin / reply seq）。 */
interface OutgoingConversion {
    element: CanonicalElement;
    atUin?: string;
    replySeq?: number;
}

/** 段 data 收窄（非对象按空对象处理，字段守卫会立即拒绝）。 */
function segmentData(seg: OutgoingSegment | RawOutgoingSegment): Record<string, unknown> {
    return isRecord(seg.data) ? seg.data : {};
}

/** 已知段缺必填字段 / 类型错误 → INVALID_PARAM。 */
function invalidSegment(type: string): never {
    throw kernelError(`Milky 消息段 ${type} 参数不合法`, "INVALID_PARAM");
}

/** text 段（必填 text: string）。 */
function textSegment(data: Record<string, unknown>): OutgoingConversion {
    if (!hasStringProp(data, "text")) {
        return invalidSegment("text");
    }
    return { element: { type: "text", text: data["text"] } };
}

/** mention 段（必填 user_id: number）。 */
function mentionSegment(data: Record<string, unknown>): OutgoingConversion {
    if (!hasNumberProp(data, "user_id")) {
        return invalidSegment("mention");
    }
    const uin = String(data["user_id"]);
    return { element: { type: "at", target: uin }, atUin: uin };
}

/** face 段（必填 face_id: string）。 */
function faceSegment(data: Record<string, unknown>): OutgoingConversion {
    if (!hasStringProp(data, "face_id")) {
        return invalidSegment("face");
    }
    return { element: { type: "face", id: data["face_id"] } };
}

/** reply 段（必填 message_seq: number）。 */
function replySegment(data: Record<string, unknown>): OutgoingConversion {
    if (!hasNumberProp(data, "message_seq")) {
        return invalidSegment("reply");
    }
    return {
        element: { type: "reply", messageId: String(data["message_seq"]) },
        replySeq: data["message_seq"],
    };
}

/** 媒体段（image/record/video，必填 uri: string）。 */
function mediaSegment(
    type: "image" | "record" | "video",
    data: Record<string, unknown>,
): OutgoingConversion {
    if (!hasStringProp(data, "uri")) {
        return invalidSegment(type);
    }
    const path = data["uri"];
    if (type === "record") {
        return { element: { type: "voice", path } };
    }
    return { element: { type: type === "image" ? "image" : "video", path } };
}

/** light_app 段（json_payload 缺省按空串，保持容忍）。 */
function lightAppSegment(data: Record<string, unknown>): OutgoingConversion {
    const payload = data["json_payload"];
    return { element: { type: "json", raw: typeof payload === "string" ? payload : "" } };
}

/** 简单段类型（无媒体载荷）。 */
type SimpleOutgoingType = "text" | "mention" | "mention_all" | "face" | "reply";

/** 简单段类型判定（字面量联合收窄）。 */
function isSimpleOutgoingType(type: string): type is SimpleOutgoingType {
    switch (type) {
        case "text":
        case "mention":
        case "mention_all":
        case "face":
        case "reply":
            return true;
        default:
            return false;
    }
}

/** 简单段分发。 */
function simpleOutgoingSegment(
    type: SimpleOutgoingType,
    data: Record<string, unknown>,
): OutgoingConversion {
    switch (type) {
        case "text":
            return textSegment(data);
        case "mention":
            return mentionSegment(data);
        case "mention_all":
            return { element: { type: "at", target: "all" } };
        case "face":
            return faceSegment(data);
        case "reply":
            return replySegment(data);
    }
}

/** 复杂段分发（媒体 / light_app / forward / 未知）。 */
function complexOutgoingSegment(
    type: string,
    data: Record<string, unknown>,
): OutgoingConversion | null {
    switch (type) {
        case "image":
            return mediaSegment("image", data);
        case "record":
            return mediaSegment("record", data);
        case "video":
            return mediaSegment("video", data);
        case "light_app":
            return lightAppSegment(data);
        case "forward":
            throw kernelError(
                "forward 段不可与其他消息段混发或嵌套（顶层 forward 须单独发送）",
                "INVALID_PARAM",
            );
        default:
            // 未知段：跳过（规范兼容性要求）
            return null;
    }
}

/** 单段分派入口（简单段 / 复杂段两级，避免单函数分支过多）。 */
function outgoingSegmentToCanonical(
    seg: OutgoingSegment | RawOutgoingSegment,
): OutgoingConversion | null {
    const data = segmentData(seg);
    if (isSimpleOutgoingType(seg.type)) {
        return simpleOutgoingSegment(seg.type, data);
    }
    return complexOutgoingSegment(seg.type, data);
}
