/**
 * 消息发送域动作
 *
 * - send_msg：message（CQ 码字符串或 segment 数组）翻译为 canonical 元素 →
 *   MsgApi.sendMessage → 返回真实 message_id；共享发送核心 sendOb11Message
 * - send_private_msg / send_group_msg：复用 sendOb11Message
 *
 * 群聊：group_id → Peer{ chatType: GROUP, peerUid: String(group_id) }（群消息 peerUid=群号）。
 * 私聊：user_id 经 uin→uid → Peer{ chatType: C2C, peerUid: uid }。
 */

import type { CanonicalElement } from "@napuketto/kernel";
import { z } from "zod";
import type { AdapterLoggerLike } from "../../../shared/log.js";
import { ensureSilk, prepareVideoElements } from "../../../shared/media.js";
import type { OneBotApi } from "../../api/one-bot-api.js";
import { applySendContext, cqMessageToCanonical, segmentsToCanonical } from "../../helper/index.js";
import type { OB11MessageSegment } from "../../types/index.js";
import { defineOb11Action, type Ob11Action } from "../base-action.js";
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

type SendMsgPayload = z.infer<typeof sendMsgSchema>;

/** send_private / send_group 共用的消息与转义字段（上界见 action/limits.ts）。 */
const sendMsgBodyFields = {
    message: z.union([z.string(), z.array(z.unknown()).max(MAX_MESSAGE_SEGMENTS)]),
    auto_escape: z.boolean().optional(),
} as const;

const sendPrivateMsgSchema = z.object({ user_id: z.number(), ...sendMsgBodyFields });

const sendGroupMsgSchema = z.object({ group_id: z.number(), ...sendMsgBodyFields });

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
    // 发送方向 ID 转换：at.qq 是 uin → uid（一次批量 uinToUid）；
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
export function createSendActions(api: OneBotApi): Ob11Action[] {
    const deps: SendMsgDeps = api;
    return [
        defineOb11Action({
            name: "send_msg",
            schema: sendMsgSchema,
            handle: (payload) => sendOb11Message(payload, deps),
        }),
        defineOb11Action({
            name: "send_private_msg",
            schema: sendPrivateMsgSchema,
            handle: (payload) => sendOb11Message(payload, deps),
        }),
        defineOb11Action({
            name: "send_group_msg",
            schema: sendGroupMsgSchema,
            handle: (payload) => sendOb11Message(payload, deps),
        }),
    ];
}
