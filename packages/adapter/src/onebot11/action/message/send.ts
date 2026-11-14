/**
 * 消息发送域动作（2026-11-14 自 send-msg / send-private-msg / send-group-msg 合并）
 *
 * - send_msg：message（CQ 码字符串或 segment 数组）翻译为 canonical 元素 →
 *   MsgApi.sendMessage → 返回真实 message_id；共享发送核心 sendOb11Message
 * - send_private_msg / send_group_msg：复用 sendOb11Message（P2-10）
 *
 * 群聊：group_id → Peer{ chatType: GROUP, peerUid: String(group_id) }（群消息 peerUid=群号）。
 * 私聊：user_id 经 uin→uid → Peer{ chatType: C2C, peerUid: uid }。
 */

import type { CanonicalElement } from "@napuketto/kernel";
import { z } from "zod";
import { BaseAction, ensureSilk, prepareVideoElements } from "../../../core/index.js";
import type { AdapterLoggerLike } from "../../../core/shared/log.js";
import type { OneBotApi } from "../../api/one-bot-api.js";
import { applySendContext, cqMessageToCanonical, segmentsToCanonical } from "../../helper/index.js";
import type { OB11MessageSegment } from "../../types/index.js";
import { ob11ErrorCodeMap } from "../error-map.js";
import { MAX_MESSAGE_SEGMENTS } from "../limits.js";
import { resolveTargetPeer } from "./resolve-peer.js";

const sendMsgSchema = z.object({
    message_type: z.enum(["group", "private"]).optional(),
    user_id: z.number().optional(),
    group_id: z.number().optional(),
    // 上界见 action/limits.ts：第三方可直接 POST 本动作，数组必须限长
    message: z.union([z.string(), z.array(z.unknown()).max(MAX_MESSAGE_SEGMENTS)]),
    auto_escape: z.boolean().optional(),
});

export type SendMsgPayload = z.infer<typeof sendMsgSchema>;

/** send_msg 依赖（OneBotApi 视图，由装配方注入）。 */
export type SendMsgDeps = Pick<OneBotApi, "msgApi" | "messageUnique" | "uinToUid" | "logger">;

/** 共享发送核心：解析 Peer → canonical 翻译（含 auto_escape）→ sendMessage → 映射 message_id。 */
async function sendOb11Message(
    payload: SendMsgPayload,
    deps: SendMsgDeps,
): Promise<{ message_id: number }> {
    const peer = await resolveTargetPeer(payload, deps, "send_msg 需要 group_id 或 user_id");
    // message: CQ 码字符串 → canonical；segment 数组 → canonical
    let canonical: CanonicalElement[];
    if (Array.isArray(payload.message)) {
        canonical = segmentsToCanonical(payload.message as OB11MessageSegment[]);
    } else {
        canonical = cqMessageToCanonical(payload.message);
    }
    // P2-19 发送方向 ID 转换：at.qq 是 uin → uid（一次批量 uinToUid）；
    // reply.id 是 OB11 message_id → NT msgId（MessageUnique 反查，反查不到原样透传）
    const atUins: string[] = [];
    for (const el of canonical) {
        if (el.type === "at" && el.target !== "all") {
            atUins.push(el.target);
        }
    }
    let uinToUid: Map<string, string> | undefined;
    if (atUins.length > 0) {
        try {
            uinToUid = await deps.uinToUid(atUins);
        } catch (err) {
            // uin 解析失败：at 原样（uin），交给 QQ 端判断（warn 留痕）
            deps.logger?.warn(
                { count: atUins.length, error: err instanceof Error ? err.message : String(err) },
                "ob11: at uin→uid 失败，at 段原样发送",
            );
        }
    }
    canonical = applySendContext(canonical, {
        ...(uinToUid !== undefined ? { uinToUid } : {}),
        ob11IdToMsgId: (id) => deps.messageUnique.getMsgId(id),
    });
    // auto_escape：文本段转义 CQ 特殊字符
    if (payload.auto_escape === true) {
        canonical = canonical.map((el) => {
            if (el.type === "text") {
                return { ...el, text: escapeText(el.text) };
            }
            return el;
        });
    }
    // 语音段：非 silk 输入转 silk（QQ 语音协议）；转换在协议层完成，kernel 不背 media（红线）
    canonical = await ensureVoiceSilk(canonical, deps.logger);
    // 视频段：缺首帧缩略图时用 ffmpeg 抽帧并补时长/尺寸（QQ 视频消息发送契约，
    // 缺失时 native 只回 sendStatus=0）
    const prepared = await prepareVideoElements(canonical);
    try {
        const { msgId } = await deps.msgApi.sendMessage(peer, prepared.elements);
        return { message_id: deps.messageUnique.alloc(msgId, peer) };
    } finally {
        await prepared.cleanup();
    }
}

/** 发送消息（P2-3 接 kernel apis/msg，返回真实 message_id）。 */
export class SendMsgAction extends BaseAction<SendMsgPayload, { message_id: number }> {
    readonly name = "send_msg";
    readonly schema = sendMsgSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly deps: SendMsgDeps;

    constructor(deps: SendMsgDeps) {
        super();
        this.deps = deps;
    }

    protected _handle(payload: SendMsgPayload): Promise<{ message_id: number }> {
        return sendOb11Message(payload, this.deps);
    }
}

const sendPrivateMsgSchema = z.object({
    user_id: z.number(),
    // 上界见 action/limits.ts
    message: z.union([z.string(), z.array(z.unknown()).max(MAX_MESSAGE_SEGMENTS)]),
    auto_escape: z.boolean().optional(),
});

type SendPrivateMsgPayload = z.infer<typeof sendPrivateMsgSchema>;

/** 发送私聊消息（P2-10 复用 sendOb11Message）。 */
export class SendPrivateMsgAction extends BaseAction<
    SendPrivateMsgPayload,
    { message_id: number }
> {
    readonly name = "send_private_msg";
    readonly schema = sendPrivateMsgSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly deps: SendMsgDeps;

    constructor(deps: SendMsgDeps) {
        super();
        this.deps = deps;
    }

    protected _handle(payload: SendPrivateMsgPayload): Promise<{ message_id: number }> {
        return sendOb11Message(payload, this.deps);
    }
}

const sendGroupMsgSchema = z.object({
    group_id: z.number(),
    // 上界见 action/limits.ts
    message: z.union([z.string(), z.array(z.unknown()).max(MAX_MESSAGE_SEGMENTS)]),
    auto_escape: z.boolean().optional(),
});

type SendGroupMsgPayload = z.infer<typeof sendGroupMsgSchema>;

/** 发送群聊消息（P2-10 复用 sendOb11Message）。 */
export class SendGroupMsgAction extends BaseAction<SendGroupMsgPayload, { message_id: number }> {
    readonly name = "send_group_msg";
    readonly schema = sendGroupMsgSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly deps: SendMsgDeps;

    constructor(deps: SendMsgDeps) {
        super();
        this.deps = deps;
    }

    protected _handle(payload: SendGroupMsgPayload): Promise<{ message_id: number }> {
        return sendOb11Message(payload, this.deps);
    }
}

/** CQ 特殊字符转义（auto_escape，&、[、]、, 前置 &amp;）。 */
function escapeText(text: string): string {
    return text
        .replaceAll("&", "&amp;")
        .replaceAll("[", "&#91;")
        .replaceAll("]", "&#93;")
        .replaceAll(",", "&#44;");
}

/** 语音元素统一转 silk：非 silk 自动转码（QQ 语音格式），已是 silk 原样。 */
async function ensureVoiceSilk(
    elements: CanonicalElement[],
    logger: AdapterLoggerLike | undefined,
): Promise<CanonicalElement[]> {
    const out: CanonicalElement[] = [];
    for (const el of elements) {
        if (el.type === "voice") {
            out.push({ ...el, path: await ensureSilk(el.path, logger) });
        } else {
            out.push(el);
        }
    }
    return out;
}

/** 消息发送域动作工厂（send_msg / send_private_msg / send_group_msg）。 */
export function createSendActions(api: OneBotApi): BaseAction<unknown, unknown>[] {
    return [new SendMsgAction(api), new SendPrivateMsgAction(api), new SendGroupMsgAction(api)];
}
