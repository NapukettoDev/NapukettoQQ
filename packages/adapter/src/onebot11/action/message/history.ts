/**
 * 消息读取域动作
 *
 * - get_msg：message_id → msgId + peer（MessageUnique 反查）→ 拉消息 → OB11 消息信息
 * - get_group_msg_history（go-cqhttp 扩展）/ get_friend_msg_history（NapCat 扩展）：
 *   拉取历史消息 → at uid 批量转换 → OB11 消息信息数组（共享 fetchAndTranslateHistory）
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
import { defineOb11Action, type Ob11Action, resolveUid } from "../base-action.js";
import { fetchMsgById } from "./resolve-peer.js";

const getMsgSchema = z.object({
    message_id: z.union([z.number(), z.string()]),
});

/** 历史消息依赖（OneBotApi 视图，由装配方注入）。 */
export type MsgHistoryDeps = Pick<
    OneBotApi,
    "msgApi" | "messageUnique" | "uidToUin" | "groupMemberRoles" | "logger"
>;

/** 默认历史消息条数。 */
const DEFAULT_HISTORY_COUNT = 20;

/** 历史消息公共参数（message_seq / count / 反向排序）。 */
const msgHistoryParamsSchema = {
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
 * 收集全部消息 at uid → 一次批量 uidToUin → 上下文注入。
 * 群聊另取发送者角色表（GroupCache 一次整表读取，失败回退缺省 member）。
 */
async function fetchAndTranslateHistory(
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
    // 收集全部消息 at uid → 一次批量 uidToUin → 上下文注入
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
        } catch (err) {
            // uid 解析失败：at 原样（uid），warn 留痕
            deps.logger?.warn(
                { count: atUids.size, error: err instanceof Error ? err.message : String(err) },
                "ob11: 历史消息 at uid→uin 失败，at 原样",
            );
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

const getGroupMsgHistorySchema = z.object({
    group_id: z.number(),
    ...msgHistoryParamsSchema,
});

const getFriendMsgHistorySchema = z.object({
    user_id: z.number(),
    ...msgHistoryParamsSchema,
});

/** 消息读取域动作工厂（get_msg / get_group_msg_history / get_friend_msg_history）。 */
export function createHistoryActions(api: OneBotApi): Ob11Action[] {
    return [
        defineOb11Action({
            name: "get_msg",
            schema: getMsgSchema,
            handle: async (payload): Promise<OB11MessageInfo> => {
                const { msg } = await fetchMsgById(
                    payload.message_id,
                    api.messageUnique,
                    api.msgApi,
                );
                // 收集 at uid → 批量 uidToUin → 上下文注入（at uid→uin、reply 映射）
                const elements = toCanonicalElements(msg);
                const { atUids } = collectReceiveNeeds(elements);
                let uidToUin: Map<string, string> | undefined;
                if (atUids.length > 0) {
                    try {
                        uidToUin = await api.uidToUin(atUids);
                    } catch (err) {
                        // uid 解析失败：at 原样（uid），warn 留痕
                        api.logger?.warn(
                            {
                                count: atUids.length,
                                error: err instanceof Error ? err.message : String(err),
                            },
                            "ob11: get_msg at uid→uin 失败，at 原样",
                        );
                    }
                }
                // 群消息查发送者角色（GroupCache 缓存优先；失败回退缺省 member）
                const senderRole =
                    msg.chatType === ChatType.GROUP
                        ? await api.groupMemberRole(msg.peerUid, msg.senderUid)
                        : undefined;
                const ctx: ReceiveTranslateContext = {
                    ...(uidToUin !== undefined ? { uidToUin } : {}),
                    ...(senderRole !== undefined ? { senderRole } : {}),
                    msgIdToOb11Id: (m) => api.messageUnique.getMessageId(m),
                };
                return toOb11MessageInfo(msg, api.messageUnique, ctx);
            },
        }),
        defineOb11Action({
            name: "get_group_msg_history",
            schema: getGroupMsgHistorySchema,
            handle: async (payload) => {
                const peer = { chatType: ChatType.GROUP, peerUid: String(payload.group_id) };
                return await fetchAndTranslateHistory(
                    peer,
                    payload.message_seq,
                    payload.count,
                    api,
                );
            },
        }),
        defineOb11Action({
            name: "get_friend_msg_history",
            schema: getFriendMsgHistorySchema,
            handle: async (payload) => {
                const uid = await resolveUid(String(payload.user_id), api.uinToUid);
                const peer = { chatType: ChatType.C2C, peerUid: uid };
                return await fetchAndTranslateHistory(
                    peer,
                    payload.message_seq,
                    payload.count,
                    api,
                );
            },
        }),
    ];
}
