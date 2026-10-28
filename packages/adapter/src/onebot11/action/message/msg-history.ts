/**
 * 历史消息动作共享逻辑（get_friend_msg_history / get_group_msg_history 共用，2026-08-08 克隆合并）
 *
 * - resolveStartMsgId：message_seq（OB11 int32 或 NT msgId）→ 起始 msgId
 * - fetchAndTranslateHistory：拉取历史消息 → at uid 批量转换 → OB11 消息信息数组
 */

import { ChatType, kernelError, toCanonicalElements } from "@napuketto/kernel";
import { z } from "zod";
import type { OneBotApi } from "../../api/one-bot-api.js";
import {
    collectReceiveNeeds,
    type GroupSenderRole,
    type ReceiveTranslateContext,
    toOb11MessageInfo,
} from "../../helper/index.js";
import type { OB11MessageInfo } from "../../types/index.js";

/** 历史消息依赖（OneBotApi 视图，由装配方注入）。 */
export type MsgHistoryDeps = Pick<
    OneBotApi,
    "msgApi" | "messageUnique" | "uidToUin" | "groupMemberRoles"
>;

/** 默认历史消息条数。 */
const DEFAULT_HISTORY_COUNT = 20;

/** 历史消息公共参数（message_seq / count / 反向排序）。 */
export const msgHistoryParamsSchema = {
    /** 起始消息序号（message_seq，缺省从最新拉）。 */
    message_seq: z.union([z.number(), z.string()]).optional(),
    count: z.number().default(DEFAULT_HISTORY_COUNT),
    /** 是否反向排序（NapCat 扩展）。 */
    reverse_order: z.boolean().optional(),
    reverseOrder: z.boolean().optional(),
} as const;

/** 解析 message_seq → 起始 msgId（int32 经 MessageUnique 反查，否则原样透传）。 */
function resolveStartMsgId(
    messageSeq: number | string | undefined,
    messageUnique: MsgHistoryDeps["messageUnique"],
): string | undefined {
    if (messageSeq === undefined) {
        return undefined;
    }
    const raw = String(messageSeq);
    const shortId = Number(raw);
    if (Number.isFinite(shortId)) {
        return messageUnique.getMsgId(shortId) ?? raw;
    }
    return raw;
}

/**
 * 拉取历史消息并翻译为 OB11 消息信息数组。
 * 收集全部消息 at uid → 一次批量 uidToUin → 上下文注入（P2-19）。
 * 群聊另取发送者角色表（GroupCache 一次整表读取，失败回退缺省 member）。
 */
export async function fetchAndTranslateHistory(
    peer: { chatType: ChatType; peerUid: string },
    messageSeq: number | string | undefined,
    count: number,
    deps: MsgHistoryDeps,
): Promise<{ messages: OB11MessageInfo[] }> {
    const startMsgId = resolveStartMsgId(messageSeq, deps.messageUnique);
    const opts: { count: number; msgId?: string } = { count };
    if (startMsgId !== undefined) {
        opts.msgId = startMsgId;
    }
    const msgs = await deps.msgApi.fetchMessages(peer, opts);
    if (msgs.length === 0) {
        throw kernelError(`消息 ${messageSeq ?? "0"} 不存在`, "NOT_FOUND");
    }
    // P2-19：收集全部消息 at uid → 一次批量 uidToUin → 上下文注入
    const atUids = new Set<string>();
    for (const m of msgs) {
        const { atUids: uids } = collectReceiveNeeds(toCanonicalElements(m));
        for (const u of uids) {
            atUids.add(u);
        }
    }
    let uidToUin: Map<string, string> | undefined;
    if (atUids.size > 0) {
        try {
            uidToUin = await deps.uidToUin([...atUids]);
        } catch {
            // uid 解析失败：at 原样（uid）
        }
    }
    const ctx: ReceiveTranslateContext = {
        ...(uidToUin !== undefined ? { uidToUin } : {}),
        msgIdToOb11Id: (m) => deps.messageUnique.getMessageId(m),
    };
    let senderRoles: Map<string, GroupSenderRole> | undefined;
    if (peer.chatType === ChatType.GROUP) {
        senderRoles = await deps.groupMemberRoles(peer.peerUid);
    }
    return {
        messages: msgs.map((msg) => {
            const role = senderRoles?.get(msg.senderUid);
            return toOb11MessageInfo(msg, deps.messageUnique, {
                ...ctx,
                ...(role !== undefined ? { senderRole: role } : {}),
            });
        }),
    };
}
