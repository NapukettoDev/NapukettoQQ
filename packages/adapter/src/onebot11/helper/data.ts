/**
 * OB11 消息翻译（ADR-008 翻译层，2026-08-08 拆分）
 *
 * - 单元素 segment 转换（canonicalToSegment / segmentToCanonical）与 CQ 码
 *   构建（CQ_SEGMENT_BUILDERS / cqCodeToSegment / segmentsToCqMessage）→ segment.ts
 * - 本文件保留：批量转换（canonicalToSegments / segmentsToCanonical）与
 *   接收方向 ID 空间翻译（collectReceiveNeeds / applyReceiveContext）
 *
 * 纯函数：只读入参、无副作用，翻译只做结构映射，不调 API、不读缓存。
 * NT 实体 ↔ canonical 在 kernel（types/message-element.ts），本文件只做
 * canonical ↔ OB11（segment / CQ 码）的薄映射。
 */

import type { CanonicalElement } from "@napuketto/kernel";
import type { OB11MessageSegment } from "../types/index.js";
import {
    canonicalToSegment,
    cqCodeToSegment,
    parseCqMessage,
    segmentsToCqMessage,
    segmentToCanonical,
} from "./codec/index.js";

/** canonical 元素数组 → OB11 segment 数组（无法表达的元素静默跳过）。 */
export function canonicalToSegments(elements: CanonicalElement[]): OB11MessageSegment[] {
    const segments: OB11MessageSegment[] = [];
    for (const el of elements) {
        const seg = canonicalToSegment(el);
        if (seg !== null) {
            segments.push(seg);
        }
    }
    return segments;
}

/** OB11 segment 数组 → canonical 元素数组。 */
export function segmentsToCanonical(segments: OB11MessageSegment[]): CanonicalElement[] {
    const elements: CanonicalElement[] = [];
    for (const seg of segments) {
        const el = segmentToCanonical(seg);
        if (el !== null) {
            elements.push(el);
        }
    }
    return elements;
}

/**
 * 接收方向翻译上下文（ID 空间转换，P2-19，2026-08-07）。
 * 翻译核心保持纯函数（ADR-008），调用方在协议边界准备上下文注入：
 * canonical 的 at.target 是 NT uid、reply.messageId 是 NT 雪花 msgId，
 * OB11 需要 uin / OB11 message_id。
 */
/** OB11 sender.role 值域（群聊；私聊 sender 无 role）。 */
export type GroupSenderRole = "owner" | "admin" | "member";

export interface ReceiveTranslateContext {
    /** uid → uin 映射（at 段目标转换；缺省不转换）。 */
    uidToUin?: Map<string, string>;
    /** NT msgId → OB11 message_id（reply 段转换；缺省不转换）。 */
    msgIdToOb11Id?: (msgId: string) => number | undefined;
    /** 群消息发送者角色（owner/admin，来自 GroupCache；缺省 member）。私聊忽略。 */
    senderRole?: GroupSenderRole;
}

/**
 * 收集 canonical 元素里需要转换的 at uid / reply NT msgId（接收方向）。
 * 调用方据此批量 uidToUin（一次异步调用），避免逐元素查询。
 */
export function collectReceiveNeeds(elements: CanonicalElement[]): {
    atUids: string[];
    replyMsgIds: string[];
} {
    const atUids = new Set<string>();
    const replyMsgIds = new Set<string>();
    for (const el of elements) {
        if (el.type === "at" && el.target !== "all") {
            atUids.add(el.target);
        } else if (el.type === "reply") {
            replyMsgIds.add(el.messageId);
        }
    }
    return { atUids: [...atUids], replyMsgIds: [...replyMsgIds] };
}

/**
 * canonical 元素数组 → 应用接收方向 ID 转换（at uid→uin、reply NT msgId→OB11 id）。
 * 转换失败的元素原样保留（uid 未解析 / msgId 未映射——不阻塞上报）。
 */
export function applyReceiveContext(
    elements: CanonicalElement[],
    ctx: ReceiveTranslateContext,
): CanonicalElement[] {
    if (ctx.uidToUin === undefined && ctx.msgIdToOb11Id === undefined) {
        return elements;
    }
    const out: CanonicalElement[] = [];
    for (const el of elements) {
        if (el.type === "at" && el.target !== "all") {
            const uin = ctx.uidToUin?.get(el.target);
            out.push(uin !== undefined ? { ...el, target: uin } : el);
            continue;
        }
        if (el.type === "reply") {
            const id = ctx.msgIdToOb11Id?.(el.messageId);
            out.push(id !== undefined ? { ...el, messageId: String(id) } : el);
            continue;
        }
        out.push(el);
    }
    return out;
}

/**
 * 发送方向翻译上下文（ID 空间转换，P2-19，2026-08-07）。
 * OB11 的 at.qq 是 uin、reply.id 是 OB11 message_id，canonical 需要 uid / NT msgId。
 */
export interface SendTranslateContext {
    /** uin → uid 映射（at 段目标转换；缺省不转换）。 */
    uinToUid?: Map<string, string>;
    /** OB11 message_id → NT msgId（reply 段转换；缺省原样透传）。 */
    ob11IdToMsgId?: (id: number) => string | undefined;
}

/** at 段：uin → uid（缺省不转换）。 */
function translateAtElement(
    el: Extract<CanonicalElement, { type: "at" }>,
    ctx: SendTranslateContext,
): CanonicalElement {
    const uid = ctx.uinToUid?.get(el.target);
    return uid !== undefined ? { ...el, target: uid } : el;
}

/** reply 段：OB11 message_id → NT msgId（反查不到原样透传）。 */
function translateReplyElement(
    el: Extract<CanonicalElement, { type: "reply" }>,
    ctx: SendTranslateContext,
): CanonicalElement {
    const num = Number(el.messageId);
    if (Number.isNaN(num)) {
        return el;
    }
    const msgId = ctx.ob11IdToMsgId?.(num);
    return msgId !== undefined ? { ...el, messageId: msgId } : el;
}

/**
 * canonical 元素数组 → 应用发送方向 ID 转换（at uin→uid、reply OB11 id→NT msgId）。
 * reply 反查不到时原样透传（兼容客户端直接给 NT msgId 的输入，不报错）。
 */
export function applySendContext(
    elements: CanonicalElement[],
    ctx: SendTranslateContext,
): CanonicalElement[] {
    if (ctx.uinToUid === undefined && ctx.ob11IdToMsgId === undefined) {
        return elements;
    }
    const out: CanonicalElement[] = [];
    for (const el of elements) {
        if (el.type === "at" && el.target !== "all") {
            out.push(translateAtElement(el, ctx));
            continue;
        }
        if (el.type === "reply") {
            out.push(translateReplyElement(el, ctx));
            continue;
        }
        out.push(el);
    }
    return out;
}

/** CQ 码字符串 → OB11 segment 数组（未知 CQ 类型保留为 text 段原文）。 */
export function cqMessageToSegments(text: string): OB11MessageSegment[] {
    const segments: OB11MessageSegment[] = [];
    for (const part of parseCqMessage(text)) {
        if (typeof part === "string") {
            if (part.length > 0) {
                segments.push({ type: "text", data: { text: part } });
            }
        } else {
            const seg = cqCodeToSegment(part);
            if (seg !== null) {
                segments.push(seg);
            }
        }
    }
    return segments;
}

/** canonical 元素数组 → CQ 码字符串。 */
export function canonicalToCqMessage(elements: CanonicalElement[]): string {
    return segmentsToCqMessage(canonicalToSegments(elements));
}

/** CQ 码字符串 → canonical 元素数组。 */
export function cqMessageToCanonical(text: string): CanonicalElement[] {
    return segmentsToCanonical(cqMessageToSegments(text));
}
