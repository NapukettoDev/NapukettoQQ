/**
 * Milky 消息段 ↔ canonical 元素转换（纯函数，ADR-008）
 *
 * 接收方向：canonical → IncomingSegment（规范 14 种中 P0 映射 12 种；
 * market_face / markdown 无 canonical 对应，unknown 一律跳过——规范兼容性
 * 要求「数组中未知项跳过」）。
 * 发送方向：OutgoingSegment → canonical（10 种中 P0 映射 9 种；forward 发送
 * 走专用内核链路，P0 显式报错不静默跳过）。
 */
import { fileURLToPath } from "node:url";
import type { CanonicalElement } from "@napuketto/kernel";
import { kernelError } from "@napuketto/kernel";
import type { IncomingSegment, OutgoingSegment } from "../types.js";

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

/** 按类型分发的段映射器表（键 = canonical type；缺项 = 跳过）。 */
const INCOMING_MAPPERS: Partial<
    Record<
        CanonicalElement["type"],
        (el: never, ctx: ReceiveSegmentContext) => IncomingSegment | null
    >
> = {
    text: (el: Extract<CanonicalElement, { type: "text" }>) => ({
        type: "text",
        data: { text: el.text },
    }),
    at: atToIncoming,
    face: (el: Extract<CanonicalElement, { type: "face" }>) => ({
        type: "face",
        data: { face_id: el.id, is_large: false },
    }),
    reply: replyToIncoming,
    image: imageToIncoming,
    voice: voiceToIncoming,
    video: videoToIncoming,
    file: fileToIncoming,
    forward: forwardToIncoming,
    json: (el: Extract<CanonicalElement, { type: "json" }>) => ({
        type: "light_app",
        data: { app_name: parseAppName(el.raw), json_payload: rawToPayload(el.raw) },
    }),
    xml: (el: Extract<CanonicalElement, { type: "xml" }>) => ({
        type: "xml",
        data: { service_id: 0, xml_payload: rawToPayload(el.raw) },
    }),
};

function canonicalToIncomingSegment(
    el: CanonicalElement,
    ctx: ReceiveSegmentContext,
): IncomingSegment | null {
    const mapper = INCOMING_MAPPERS[el.type];
    // unknown / 未映射类型：跳过（规范兼容性要求）
    return mapper === undefined ? null : mapper(el as never, ctx);
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

/** canonical forward → forward 段（title/preview/summary 无 canonical 来源，空兜底）。 */
function forwardToIncoming(el: Extract<CanonicalElement, { type: "forward" }>): IncomingSegment {
    return {
        type: "forward",
        data: {
            forward_id: el.messageIds[0] ?? "",
            title: "",
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
    if (typeof obj !== "object" || obj === null || !("app" in obj)) {
        return "";
    }
    const app = (obj as Record<string, unknown>)["app"];
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
 * forward 显式报错（发送走 kernel 专用链路，P1 接）。
 */
export function outgoingSegmentsToCanonical(segments: OutgoingSegment[]): {
    elements: CanonicalElement[];
    atUins: string[];
    replySeqs: number[];
} {
    const elements: CanonicalElement[] = [];
    const atUins: string[] = [];
    const replySeqs: number[] = [];
    for (const seg of segments) {
        switch (seg.type) {
            case "text":
                elements.push({ type: "text", text: seg.data.text });
                break;
            case "mention": {
                const uin = String(seg.data.user_id);
                atUins.push(uin);
                elements.push({ type: "at", target: uin });
                break;
            }
            case "mention_all":
                elements.push({ type: "at", target: "all" });
                break;
            case "face":
                elements.push({ type: "face", id: seg.data.face_id });
                break;
            case "reply": {
                replySeqs.push(seg.data.message_seq);
                elements.push({ type: "reply", messageId: String(seg.data.message_seq) });
                break;
            }
            case "image":
                elements.push({ type: "image", path: resolveUriToPathPlaceholder(seg.data.uri) });
                break;
            case "record":
                elements.push({ type: "voice", path: resolveUriToPathPlaceholder(seg.data.uri) });
                break;
            case "video":
                elements.push({ type: "video", path: resolveUriToPathPlaceholder(seg.data.uri) });
                break;
            case "light_app":
                elements.push({ type: "json", raw: seg.data.json_payload });
                break;
            case "forward":
                throw kernelError("forward 段发送暂未支持（P1 接内核转发链路）", "INVALID_PARAM");
            default:
                // 未知段：跳过（规范兼容性要求）
                break;
        }
    }
    return { elements, atUins, replySeqs };
}

/**
 * 媒体 URI → 本地路径（同步面：file:// / 裸路径直接给 canonical；base64:// 与
 * http(s):// 需要异步落盘，由 send 核心在 canonical 上二次解析——此处先放原始
 * URI 作占位，send 核心按元素类型调用 resolveMediaUri 替换）。
 */
function resolveUriToPathPlaceholder(uri: string): string {
    if (uri.startsWith("file://")) {
        return fileUriToPath(uri);
    }
    if (uri.startsWith("http://") || uri.startsWith("https://") || uri.startsWith("base64://")) {
        return uri;
    }
    // 裸路径（go-cqhttp 惯例）：按本地路径处理
    return uri;
}

/** file:// 前缀（fileURLToPath 失败时的裸剥离兜底）。 */
const FILE_URI_PREFIX_RE = /^file:\/\//;

/** file:// URI → 平台路径（Windows 盘符兼容）。 */
function fileUriToPath(uri: string): string {
    try {
        return fileURLToPath(uri);
    } catch {
        return uri.replace(FILE_URI_PREFIX_RE, "");
    }
}
