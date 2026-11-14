/**
 * OB11 segment 单元素转换（从 data.ts 拆分，FTA 优化）
 *
 * - canonicalToSegment / segmentToCanonical：单元素 ↔ 单 segment（null = 无法表达跳过）
 * - CQ_SEGMENT_BUILDERS / cqCodeToSegment：CQ 码 → segment（未知类型保留原文为文本段）
 */
import type { CanonicalElement } from "@napuketto/kernel";
import type { OB11MessageSegment } from "../../types/index.js";
import { type CqCode, encodeCqCode, escapeCqText } from "./cqcode.js";

/** OB11 媒体段 data（image/record/video 共用，url 可选）。 */
function mediaData(file: string, url: string | undefined): { file: string; url?: string } {
    const data: { file: string; url?: string } = { file };
    if (url !== undefined) {
        data.url = url;
    }
    return data;
}

/** OB11 at 段 data（name 可选）。 */
function atData(qq: string, name: string | undefined): { qq: string; name?: string } {
    const data: { qq: string; name?: string } = { qq };
    if (name !== undefined) {
        data.name = name;
    }
    return data;
}

/** canonical at 元素（display 可选）。 */
function canonicalAt(target: string, display: string | undefined): CanonicalElement {
    const el: CanonicalElement = { type: "at", target };
    if (display !== undefined) {
        el.display = display;
    }
    return el;
}

/** canonical 媒体元素子集（image/voice/video 均含 url 可选字段）。 */
type MediaCanonical =
    | { type: "image"; path: string; url?: string; size?: { width: number; height: number } }
    | { type: "voice"; path: string; url?: string }
    | { type: "video"; path: string; url?: string };

/** canonical 媒体元素（image/voice/video，url 可选；type 为联合需断言收窄）。 */
function canonicalMedia(
    type: "image" | "voice" | "video",
    path: string,
    url: string | undefined,
): CanonicalElement {
    const el: MediaCanonical = { type, path } as MediaCanonical;
    if (url !== undefined) {
        el.url = url;
    }
    return el;
}

/** canonical json/xml 的 raw → OB11 data 字符串（字符串原样，对象序列化）。 */
function rawToString(raw: unknown): string {
    if (typeof raw === "string") {
        return raw;
    }
    return JSON.stringify(raw);
}

/** canonical 元素 → OB11 segment 转换器（键 = canonical type，判别字段收窄）。 */
const CANONICAL_TO_SEGMENT: Record<string, (el: never) => OB11MessageSegment> = {
    text: (el: Extract<CanonicalElement, { type: "text" }>) => ({
        type: "text" as const,
        data: { text: el.text },
    }),
    at: (el: Extract<CanonicalElement, { type: "at" }>) => ({
        type: "at" as const,
        data: atData(el.target, el.display),
    }),
    image: (el: Extract<CanonicalElement, { type: "image" }>) => ({
        type: "image" as const,
        data: mediaData(el.path, el.url),
    }),
    face: (el: Extract<CanonicalElement, { type: "face" }>) => ({
        type: "face" as const,
        data: { id: el.id },
    }),
    voice: (el: Extract<CanonicalElement, { type: "voice" }>) => ({
        type: "record" as const,
        data: mediaData(el.path, el.url),
    }),
    video: (el: Extract<CanonicalElement, { type: "video" }>) => ({
        type: "video" as const,
        data: mediaData(el.path, el.url),
    }),
    // 群/私聊文件（）：data.file 取文件名（缺省路径）——go-cqhttp
    // 兼容形状;此前 file 元素被静默丢弃（转换表无此键）
    file: (el: Extract<CanonicalElement, { type: "file" }>) => ({
        type: "file" as const,
        data: { file: el.name ?? el.path },
    }),
    reply: (el: Extract<CanonicalElement, { type: "reply" }>) => ({
        type: "reply" as const,
        data: { id: el.messageId },
    }),
    forward: (el: Extract<CanonicalElement, { type: "forward" }>) => ({
        type: "forward" as const,
        data: { id: el.messageIds[0] ?? "" },
    }),
    json: (el: Extract<CanonicalElement, { type: "json" }>) => ({
        type: "json" as const,
        data: { data: rawToString(el.raw) },
    }),
    xml: (el: Extract<CanonicalElement, { type: "xml" }>) => ({
        type: "xml" as const,
        data: { data: rawToString(el.raw) },
    }),
};

/** canonical 元素 → OB11 segment（null = OB11 无法表达，跳过）。 */
export function canonicalToSegment(el: CanonicalElement): OB11MessageSegment | null {
    const builder = CANONICAL_TO_SEGMENT[el.type];
    // el.type 是判别字段，与映射键一一对应；as never 规避联合逆变检查
    return builder === undefined ? null : builder(el as never);
}

/** OB11 segment → canonical 元素转换器（键 = segment type）。 */
const SEGMENT_TO_CANONICAL: Record<string, (seg: never) => CanonicalElement> = {
    text: (seg: Extract<OB11MessageSegment, { type: "text" }>) => ({
        type: "text" as const,
        text: seg.data.text,
    }),
    string: (seg: Extract<OB11MessageSegment, { type: "string" }>) => ({
        type: "text" as const,
        text: seg.data.text,
    }),
    at: (seg: Extract<OB11MessageSegment, { type: "at" }>) =>
        canonicalAt(seg.data.qq, seg.data.name),
    face: (seg: Extract<OB11MessageSegment, { type: "face" }>) => ({
        type: "face" as const,
        id: seg.data.id,
    }),
    image: (seg: Extract<OB11MessageSegment, { type: "image" }>) =>
        canonicalMedia("image", seg.data.file, seg.data.url),
    record: (seg: Extract<OB11MessageSegment, { type: "record" }>) =>
        canonicalMedia("voice", seg.data.file, seg.data.url),
    video: (seg: Extract<OB11MessageSegment, { type: "video" }>) =>
        canonicalMedia("video", seg.data.file, seg.data.url),
    reply: (seg: Extract<OB11MessageSegment, { type: "reply" }>) => ({
        type: "reply" as const,
        messageId: seg.data.id,
    }),
    forward: (seg: Extract<OB11MessageSegment, { type: "forward" }>) => ({
        type: "forward" as const,
        messageIds: [seg.data.id],
    }),
    json: (seg: Extract<OB11MessageSegment, { type: "json" }>) => ({
        type: "json" as const,
        raw: seg.data.data,
    }),
    xml: (seg: Extract<OB11MessageSegment, { type: "xml" }>) => ({
        type: "xml" as const,
        raw: seg.data.data,
    }),
};

/** OB11 segment → canonical 元素（未知 type 兜底按 xml 处理，保持既有行为）。 */
export function segmentToCanonical(seg: OB11MessageSegment): CanonicalElement | null {
    const builder = SEGMENT_TO_CANONICAL[seg.type];
    if (builder !== undefined) {
        return builder(seg as never);
    }
    // 未知 type：兜底按 xml 处理（表字面量恒含 xml 键，此处仅类型收窄）
    const xmlBuilder = SEGMENT_TO_CANONICAL["xml"];
    return xmlBuilder === undefined ? null : xmlBuilder(seg as never);
}

/** CQ 段构造器（params 键可能缺失，undefined 用空串兜底）。 */
type CqSegmentBuilder = (params: Record<string, string | undefined>) => OB11MessageSegment;

/** 已知 CQ 类型 → segment 构造器。 */
const CQ_SEGMENT_BUILDERS: Record<string, CqSegmentBuilder> = {
    text: (params) => ({ type: "text", data: { text: params["text"] ?? "" } }),
    at: (params) => ({ type: "at", data: atData(params["qq"] ?? "", params["name"]) }),
    face: (params) => ({ type: "face", data: { id: params["id"] ?? "" } }),
    image: (params) => ({
        type: "image",
        data: mediaData(params["file"] ?? "", params["url"]),
    }),
    record: (params) => ({
        type: "record",
        data: mediaData(params["file"] ?? "", params["url"]),
    }),
    video: (params) => ({
        type: "video",
        data: mediaData(params["file"] ?? "", params["url"]),
    }),
    file: (params) => ({
        type: "file",
        data: { file: params["file"] ?? "" },
    }),
    reply: (params) => ({ type: "reply", data: { id: params["id"] ?? "" } }),
    forward: (params) => ({ type: "forward", data: { id: params["id"] ?? "" } }),
    json: (params) => ({ type: "json", data: { data: params["data"] ?? "" } }),
    xml: (params) => ({ type: "xml", data: { data: params["data"] ?? "" } }),
};

/** CQ 码片段 → OB11 segment（未知类型保留原文为 text 段，往返不丢数据）。 */
export function cqCodeToSegment(code: CqCode): OB11MessageSegment | null {
    const builder = CQ_SEGMENT_BUILDERS[code.type];
    if (builder === undefined) {
        // 未知 CQ 类型：保留原文为文本段（go-cqhttp 兼容行为）
        return { type: "text", data: { text: encodeCqCode(code.type, code.params) } };
    }
    return builder(code.params);
}

/** OB11 segment 数组 → CQ 码字符串（text 段转义拼接，特殊段编码）。 */
export function segmentsToCqMessage(segments: OB11MessageSegment[]): string {
    let out = "";
    for (const seg of segments) {
        if (seg.type === "text" || seg.type === "string") {
            out += escapeCqText(seg.data.text);
        } else {
            out += encodeCqCode(seg.type, seg.data);
        }
    }
    return out;
}
