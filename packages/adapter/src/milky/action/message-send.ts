/**
 * Milky 消息发送域动作（2026-11-14 自 message.ts 拆分，结构重构会话 4/5）
 *
 * P0：send_private_message / send_group_message。
 * 发送核心 sendMilkyMessage：OutgoingSegment → canonical（媒体 URI 异步落盘 +
 * at uin→uid + reply seq→msgId 原样兜底）→ MsgApi.sendMessage → 回查 msgSeq/time。
 * forward 段走专用组装链（sendForwardComposition，临时消息法，见 milky.md §0.6）。
 */
import type { CanonicalElement, Peer } from "@napuketto/kernel";
import { kernelError } from "@napuketto/kernel";
import { type ZodType, z } from "zod";
import type { MilkyApi } from "../api.js";
import { resolveMediaUri } from "../helper/message/media-uri.js";
import { outgoingSegmentsToCanonical } from "../helper/message/segments.js";
import type { OutgoingForwardedMessage, OutgoingSegment, SendMessageOutput } from "../types.js";
import { MilkyApiAction } from "./base-action.js";

/**
 * OutgoingSegment 宽松校验：入口只保证「{type, data}」形状，字段级转换在
 * outgoingSegmentsToCanonical 内做（未知段跳过 = 规范兼容性要求）。
 */
const outgoingSegmentSchema = z
    .object({ type: z.string(), data: z.record(z.string(), z.unknown()) })
    .loose() as unknown as ZodType<OutgoingSegment>;

/**
 * 单条消息的段数上限（2026-11-03 依赖审计整改）：.min(1) 只保下界，不设上界时
 * 第三方可 POST 十万个合法段让 zod 逐项解析（zod 4.6.1 的 CWE-770 是内存放大，
 * 补丁版只修放大、不修「无界数组」本身）。真实单条 QQ 消息远低于此值。
 */
const MAX_OUTGOING_SEGMENTS = 200;

const sendMessageFields = {
    message: z.array(outgoingSegmentSchema).min(1).max(MAX_OUTGOING_SEGMENTS),
} as const;

/** send_private_message：发送私聊消息。 */
export class SendPrivateMessageAction extends MilkyApiAction<
    { user_id: number; message: OutgoingSegment[] },
    SendMessageOutput
> {
    readonly name = "send_private_message";
    readonly schema = z.object({ user_id: z.number().int().min(10001), ...sendMessageFields });

    protected async _handle(payload: {
        user_id: number;
        message: OutgoingSegment[];
    }): Promise<SendMessageOutput> {
        const peer = await this.api.resolvePeer("friend", payload.user_id);
        return await sendMilkyMessage(peer, payload.message, this.api);
    }
}

/** send_group_message：发送群聊消息。 */
export class SendGroupMessageAction extends MilkyApiAction<
    { group_id: number; message: OutgoingSegment[] },
    SendMessageOutput
> {
    readonly name = "send_group_message";
    readonly schema = z.object({ group_id: z.number().int().min(10001), ...sendMessageFields });

    protected async _handle(payload: {
        group_id: number;
        message: OutgoingSegment[];
    }): Promise<SendMessageOutput> {
        const peer = await this.api.resolvePeer("group", payload.group_id);
        return await sendMilkyMessage(peer, payload.message, this.api);
    }
}

/** ---------- 发送核心与组装链 ---------- */

/** 发送核心：segments → canonical（URI/ID 转换）→ sendMessage → 回查输出。
 *  forward 段分流到组装链（P2 批次一，临时消息法）。 */
export async function sendMilkyMessage(
    peer: Peer,
    segments: OutgoingSegment[],
    api: MilkyApi,
): Promise<SendMessageOutput> {
    if (segments.some((s) => s.type === "forward")) {
        return await sendForwardComposition(peer, segments, api);
    }
    const { elements, atUins } = outgoingSegmentsToCanonical(segments);
    const resolved = await resolveElements(elements, atUins, api);
    if (resolved.length === 0) {
        throw kernelError("消息内容为空（全部消息段不可用）", "INVALID_PARAM");
    }
    const { msgId } = await api.msgApi.sendMessage(peer, resolved);
    return await api.resolveSentOutput(peer, msgId);
}

/**
 * forward 段组装链（P2 批次一，milky.md §0.6）：仅支持单 forward 单独发。
 * 临时消息法：逐条发送 messages[i].segments → sendForwardMessage（buildMultiForwardMsg
 * 以目标 peer 的真实消息组装 → sendMsg）→ best-effort 撤回临时消息 → 回查输出。
 *
 * 已知差异（规范语义 vs kernel 出口，待实机联调）：节点发送者恒为机器人自己
 * （user_id / sender_name / time 不参与组装）；title / preview / summary / prompt 忽略。
 */
async function sendForwardComposition(
    peer: Peer,
    segments: OutgoingSegment[],
    api: MilkyApi,
): Promise<SendMessageOutput> {
    if (segments.length !== 1) {
        throw kernelError("forward 段必须单独发送（不支持与其他消息段混发）", "INVALID_PARAM");
    }
    const [forward] = segments;
    if (forward === undefined || forward.type !== "forward") {
        throw kernelError("forward 组装链收到非 forward 段", "UNKNOWN");
    }
    const messages = narrowForwardMessages(forward);
    const srcMsgIds: string[] = [];
    for (const [i, item] of messages.entries()) {
        const { elements, atUins } = outgoingSegmentsToCanonical(item.segments);
        const resolved = await resolveElements(elements, atUins, api);
        if (resolved.length === 0) {
            throw kernelError(`forward 第 ${i + 1} 条消息无可用内容段`, "INVALID_PARAM");
        }
        const { msgId } = await api.msgApi.sendMessage(peer, resolved);
        srcMsgIds.push(msgId);
    }
    const { msgId } = await api.msgApi.sendForwardMessage(peer, peer, srcMsgIds);
    await recallTempMessages(peer, srcMsgIds, api);
    return await api.resolveSentOutput(peer, msgId);
}

/**
 * forward 段载荷收窄（入口 schema 只保证 data 为 record）：messages 非空数组，
 * 项内 segments 非空数组。user_id / sender_name / time 不参与组装不校验
 * （丢弃字段不设门槛）；title / preview / summary / prompt 忽略。
 */
function narrowForwardMessages(
    forward: Extract<OutgoingSegment, { type: "forward" }>,
): OutgoingForwardedMessage[] {
    const raw = (forward.data as { messages?: unknown }).messages;
    if (!Array.isArray(raw) || raw.length === 0) {
        throw kernelError("forward 段 messages 必须是非空数组", "INVALID_PARAM");
    }
    const out: OutgoingForwardedMessage[] = [];
    for (const item of raw) {
        if (typeof item !== "object" || item === null) {
            throw kernelError("forward 段 messages 项必须是对象", "INVALID_PARAM");
        }
        const segments = (item as { segments?: unknown }).segments;
        if (!Array.isArray(segments) || segments.length === 0) {
            throw kernelError("forward 段 messages 项的 segments 必须是非空数组", "INVALID_PARAM");
        }
        out.push(item as OutgoingForwardedMessage);
    }
    return out;
}

/** 临时消息清理（best-effort：失败只留可见垃圾，转发已发出——warn 可观测不抛）。 */
async function recallTempMessages(peer: Peer, msgIds: string[], api: MilkyApi): Promise<void> {
    try {
        await api.msgApi.recallMessage(peer, msgIds);
    } catch (e) {
        api.logger?.warn(
            {
                peer: peer.peerUid,
                count: msgIds.length,
                error: e instanceof Error ? e.message : String(e),
            },
            "milky: forward 临时消息撤回失败（转发已发出）",
        );
    }
}

/** ---------- 元素二次解析 ---------- */

/** 元素二次解析：at uin→uid + 远程媒体 URI 落盘（reply seq 已在映射层兜底原样）。 */
async function resolveElements(
    elements: CanonicalElement[],
    atUins: string[],
    api: MilkyApi,
): Promise<CanonicalElement[]> {
    const uinToUid = await resolveAtUins(atUins, api);
    const out: CanonicalElement[] = [];
    for (const el of elements) {
        out.push(await resolveElement(el, uinToUid, api));
    }
    return out;
}

/** at uin→uid 批量转换（失败返回 undefined：at 原样 uin，交 QQ 端判断）。 */
async function resolveAtUins(
    atUins: string[],
    api: MilkyApi,
): Promise<Map<string, string> | undefined> {
    if (atUins.length === 0) {
        return undefined;
    }
    try {
        return await api.uinToUid(atUins);
    } catch {
        return undefined;
    }
}

/** 单元素解析：at 目标替换 / 远程媒体 URI 落盘 / 其余原样。 */
async function resolveElement(
    el: CanonicalElement,
    uinToUid: Map<string, string> | undefined,
    api: MilkyApi,
): Promise<CanonicalElement> {
    if (el.type === "at" && el.target !== "all") {
        return { ...el, target: uinToUid?.get(el.target) ?? el.target };
    }
    if (isRemoteMediaUri(el)) {
        const media = el as Extract<CanonicalElement, { type: "image" | "voice" | "video" }>;
        return { ...media, path: await resolveMediaUri(media.path, api.mediaDir) };
    }
    return el;
}

/** 远程媒体元素（image/voice/video 且 path 为需落盘的 URI）。 */
function isRemoteMediaUri(el: CanonicalElement): boolean {
    return (
        (el.type === "image" || el.type === "voice" || el.type === "video") &&
        (el.path.startsWith("http://") ||
            el.path.startsWith("https://") ||
            el.path.startsWith("base64://"))
    );
}
