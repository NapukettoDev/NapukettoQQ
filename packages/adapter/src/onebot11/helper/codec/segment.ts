/**
 * OB11 segment 单元素转换（从 data.ts 拆分，FTA 优化）
 *
 * - isOB11MessageSegment / parseOB11MessageSegments：入站 segment 的运行时形状守卫
 *   （HTTP 载荷是不可信输入，禁止 `as OB11MessageSegment[]` 直转）
 * - canonicalToSegment / segmentToCanonical：单元素 ↔ 单 segment（null = 无法表达跳过）
 *   ——按 `switch (el.type)` / `switch (seg.type)` 走可辨识联合分支，编译器自然收窄，
 *   不再用「键 → builder（入参强转 never）」查表绕过联合逆变检查。
 * - CQ_SEGMENT_BUILDERS / cqCodeToSegment：CQ 码 → segment（未知类型保留原文为文本段）
 *
 * 运行时数值容忍：OB11 规范允许 `at.qq` / `face.id` / `reply.id` 等为 number，
 * 守卫接受 string | number，转换时统一 String() 归一（canonical 字段恒为 string）。
 */
import type { CanonicalElement } from "@napuketto/kernel";
import { hasOptionalStringProp, hasStringProp, isRecord, kernelError } from "@napuketto/kernel";
import type { OB11MessageSegment } from "../../types/index.js";
import { type CqCode, encodeCqCode, escapeCqText } from "./cqcode.js";

/** 校验失败统一文案（协议入站边界，ADR-009）。 */
const INVALID_SEGMENT_MESSAGE = "OneBot11 消息段格式不合法";

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

/** canonical 媒体元素（image/voice/video，url 可选；分支内收窄，无需断言）。 */
function canonicalMedia(
    type: "image" | "voice",
    path: string,
    url: string | undefined,
): CanonicalElement {
    switch (type) {
        case "image":
            return url === undefined ? { type: "image", path } : { type: "image", path, url };
        case "voice":
            return url === undefined ? { type: "voice", path } : { type: "voice", path, url };
    }
}

/** canonical json/xml 的 raw → OB11 data 字符串（字符串原样，对象序列化）。 */
function rawToString(raw: unknown): string {
    if (typeof raw === "string") {
        return raw;
    }
    return JSON.stringify(raw);
}

/** 字段是否为 string | number（OB11 数值型 id 的容忍形态）。 */
function isStringOrNumber(val: unknown): boolean {
    return typeof val === "string" || typeof val === "number";
}

/**
 * OB11 消息段形状守卫：`type` 为 string，`data` 为对象，且**已知类型的必填字段**
 * 类型正确。未知 `type` 一律判非法（发送入口显式拒绝，不静默丢段）。
 */
export function isOB11MessageSegment(val: unknown): val is OB11MessageSegment {
    if (!isRecord(val) || !hasStringProp(val, "type")) {
        return false;
    }
    const data = val["data"];
    if (!isRecord(data)) {
        return false;
    }
    switch (val["type"]) {
        case "text":
        case "string":
            return hasStringProp(data, "text");
        case "at":
            return isStringOrNumber(data["qq"]) && hasOptionalStringProp(data, "name");
        case "face":
            return isStringOrNumber(data["id"]);
        case "image":
        case "record":
            return hasStringProp(data, "file") && hasOptionalStringProp(data, "url");
        case "video":
            return (
                hasStringProp(data, "file") &&
                hasOptionalStringProp(data, "url") &&
                hasOptionalStringProp(data, "thumb")
            );
        case "file":
            return hasStringProp(data, "file");
        case "reply":
        case "forward":
            return isStringOrNumber(data["id"]);
        case "json":
        case "xml":
            return typeof data["data"] === "string" || isRecord(data["data"]);
        default:
            return false;
    }
}

/**
 * 校验并收窄入站 segment 数组（HTTP 动作载荷 → OB11MessageSegment[]）。
 * 任一项不合法即抛 INVALID_PARAM（ADR-009 外部边界统一错误语义）。
 */
export function parseOB11MessageSegments(raw: readonly unknown[]): OB11MessageSegment[] {
    const out: OB11MessageSegment[] = [];
    for (const item of raw) {
        if (!isOB11MessageSegment(item)) {
            throw kernelError(INVALID_SEGMENT_MESSAGE, "INVALID_PARAM");
        }
        out.push(item);
    }
    return out;
}

/** canonical 元素 → OB11 segment（null = OB11 无法表达，跳过）。 */
export function canonicalToSegment(el: CanonicalElement): OB11MessageSegment | null {
    switch (el.type) {
        case "text":
            return { type: "text", data: { text: el.text } };
        case "at":
            return { type: "at", data: atData(el.target, el.display) };
        case "image":
            return { type: "image", data: mediaData(el.path, el.url) };
        case "face":
            return { type: "face", data: { id: el.id } };
        case "voice":
            return { type: "record", data: mediaData(el.path, el.url) };
        case "video":
            return { type: "video", data: mediaData(el.path, el.url) };
        // 群/私聊文件：data.file 取文件名（缺省路径）——go-cqhttp 兼容形状
        case "file":
            return { type: "file", data: { file: el.name ?? el.path } };
        case "reply":
            return { type: "reply", data: { id: el.messageId } };
        case "forward":
            return { type: "forward", data: { id: el.messageIds[0] ?? "" } };
        case "json":
            return { type: "json", data: { data: rawToString(el.raw) } };
        case "xml":
            return { type: "xml", data: { data: rawToString(el.raw) } };
        case "unknown":
            return null;
        default:
            return null;
    }
}

/**
 * OB11 segment → canonical 元素（未知 type 兜底按 xml 处理，保持既有行为）。
 * 入参已由 isOB11MessageSegment 收窄；类型侧调用（内部 CQ 码生成 / 接收方向翻译）
 * 直接传 OB11MessageSegment，default 分支仅在运行时出现意外 type 时命中。
 */
export function segmentToCanonical(seg: OB11MessageSegment): CanonicalElement | null {
    const rawSegment: unknown = seg;
    switch (seg.type) {
        case "text":
        case "string":
            return { type: "text", text: seg.data.text };
        case "at":
            return canonicalAt(String(seg.data.qq), seg.data.name);
        case "face":
            return { type: "face", id: String(seg.data.id) };
        case "image":
            return canonicalMedia("image", seg.data.file, seg.data.url);
        case "record":
            return canonicalMedia("voice", seg.data.file, seg.data.url);
        case "video":
            return {
                type: "video",
                path: seg.data.file,
                ...(seg.data.url === undefined ? {} : { url: seg.data.url }),
                ...(seg.data.thumb === undefined ? {} : { thumbPath: seg.data.thumb }),
            };
        case "reply":
            return { type: "reply", messageId: String(seg.data.id) };
        case "forward":
            return { type: "forward", messageIds: [String(seg.data.id)] };
        case "json":
            return { type: "json", raw: seg.data.data };
        case "xml":
            return { type: "xml", raw: seg.data.data };
        default: {
            // 未知 type：兜底按 xml 处理（数据字段缺失 → raw undefined）
            const data = isRecord(rawSegment) ? rawSegment["data"] : undefined;
            return { type: "xml", raw: isRecord(data) ? data["data"] : undefined };
        }
    }
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
        data: {
            ...mediaData(params["file"] ?? "", params["url"]),
            ...(params["thumb"] === undefined ? {} : { thumb: params["thumb"] }),
        },
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
