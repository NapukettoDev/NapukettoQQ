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

import type { CanonicalElement, Peer } from "@napuketto/kernel";
import { ChatType, errorMessage } from "@napuketto/kernel";
import { z } from "zod";
import type { OneBotApi } from "../../api/onebot-api.js";
import {
    applySendContext,
    cqMessageToCanonical,
    parseOB11MessageSegments,
    segmentsToCanonical,
} from "../../helper/index.js";
import { defineOb11Action, type Ob11Action, resolveTargetPeer } from "../base-action.js";
import { MAX_MESSAGE_SEGMENTS } from "../limits.js";
import { prepareOb11MessageMedia } from "./media-preparation.js";

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
export type SendMsgDeps = Pick<
    OneBotApi,
    | "msgApi"
    | "messageUnique"
    | "uinToUid"
    | "logger"
    | "getLocalMediaRoots"
    | "getMediaOutboundPolicy"
    | "getMessageMediaBudget"
    | "onMessageMediaPrepared"
    | "groupCache"
>;

/** NT UID 前缀（`u_...`：调用方直接给 uid，发送方向直通，不再走 uinToUid）。 */
const UID_PREFIX = "u_";

/** 共享发送核心：解析 Peer → canonical 翻译（含 auto_escape）→ sendMessage → 映射 message_id。 */
async function sendOb11Message(
    payload: SendMsgPayload,
    deps: SendMsgDeps,
): Promise<{ message_id: number }> {
    const peer = await resolveTargetPeer(payload, deps, "send_msg 需要 group_id 或 user_id");
    // message: CQ 码字符串 → canonical；segment 数组 → 运行时守卫收窄 → canonical
    let canonical: CanonicalElement[];
    if (Array.isArray(payload.message)) {
        canonical = segmentsToCanonical(parseOB11MessageSegments(payload.message));
    } else {
        canonical = cqMessageToCanonical(payload.message);
    }
    const prepared = await prepareOb11MessageMedia(canonical, deps, deps.getMessageMediaBudget?.());
    canonical = prepared.elements;
    try {
        await deps.onMessageMediaPrepared?.(prepared.stats);
    } catch (err) {
        deps.logger?.warn({ error: errorMessage(err) }, "OB11 媒体准备统计回调失败");
    }
    // 发送方向 ID 转换：at.qq 是 uin → uid（一次批量 uinToUid）；
    // reply.id 是 OB11 message_id → NT msgId（MessageUnique 反查，反查不到原样透传）。
    // `u_...` 已是 NT UID（调用方直接给 uid）：直通，不参与 uin→uid 批量转换
    // （与 loader ipc-actions 的 resolveAtElements 同契约）。
    const atUins: string[] = [];
    for (const el of canonical) {
        if (el.type === "at" && el.target !== "all" && !el.target.startsWith(UID_PREFIX)) {
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
                { count: atUins.length, error: errorMessage(err) },
                "ob11: at uin→uid 失败，at 段原样发送",
            );
        }
    }
    canonical = applySendContext(canonical, {
        ...(uinToUid !== undefined ? { uinToUid } : {}),
        ob11IdToMsgId: (id) => deps.messageUnique.getMsgId(id),
    });
    // 群聊 at 段补显示名（uid → 群名片/昵称）：kernel 用它作 TEXT content，
    // 缺失时聊天框只剩「@」（fail-soft，查不到不影响发送）
    canonical = await fillAtDisplays(canonical, peer, deps);
    // auto_escape：文本段转义 CQ 特殊字符
    if (payload.auto_escape === true) {
        canonical = canonical.map((el) => {
            if (el.type === "text") {
                return { ...el, text: escapeText(el.text) };
            }
            return el;
        });
    }
    const { msgId } = await deps.msgApi.sendMessage(peer, canonical);
    return { message_id: deps.messageUnique.alloc(msgId, peer) };
}

/** send_msg 依赖中 groupCache 的非空视图（补 at 显示名用）。 */
type MemberCache = NonNullable<SendMsgDeps["groupCache"]>;

/**
 * 群聊 at 段显示名补全（uid → 群名片优先、昵称兜底）。
 *
 * 仅补「已是 uid + 无 display」的单人 at：@全体、数字 uin（转换失败保留的 uin）、
 * 非群聊或未装配 groupCache 时原样返回；查询失败只留 debug 痕迹（fail-soft，不阻塞发送）。
 */
async function fillAtDisplays(
    elements: CanonicalElement[],
    peer: Peer,
    deps: SendMsgDeps,
): Promise<CanonicalElement[]> {
    const groupCache = deps.groupCache;
    if (peer.chatType !== ChatType.GROUP || groupCache === undefined) {
        return elements;
    }
    const out: CanonicalElement[] = [];
    for (const el of elements) {
        if (
            el.type !== "at" ||
            el.target === "all" ||
            !el.target.startsWith(UID_PREFIX) ||
            (el.display !== undefined && el.display !== "")
        ) {
            out.push(el);
            continue;
        }
        const display = await memberDisplayName(deps, groupCache, peer.peerUid, el.target);
        out.push(display === undefined ? el : { ...el, display });
    }
    return out;
}

/** 群成员显示名（群名片 → 昵称；查不到/抛错返回 undefined）。 */
async function memberDisplayName(
    deps: SendMsgDeps,
    groupCache: MemberCache,
    groupCode: string,
    uid: string,
): Promise<string | undefined> {
    try {
        const member = await groupCache.getMember(groupCode, uid);
        if (member === undefined) {
            return undefined;
        }
        const name = member.cardName ?? member.nick;
        return name === undefined || name === "" ? undefined : name;
    } catch (err) {
        deps.logger?.debug(
            { group: groupCode, error: errorMessage(err) },
            "ob11: at 群成员显示名查询失败（at 段无 display）",
        );
        return undefined;
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
