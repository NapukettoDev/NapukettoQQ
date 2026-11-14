/**
 * OB11 目标 Peer 解析 / 单条消息拉取（多个动作共用）
 *
 * group_id 直通（群消息 peerUid = 群号）；user_id 经 uin→uid 解析。
 */

import { ChatType, kernelError, type Peer, type RawMessage } from "@napuketto/kernel";
import type { MessageUnique } from "../../helper/message-unique.js";
import { resolveMsgIdAndPeer } from "../../helper/message-unique.js";

/** 解析目标 Peer（group_id 直通；user_id 经 uin→uid）。 */
export async function resolveTargetPeer(
    payload: { group_id?: number | undefined; user_id?: number | undefined },
    deps: { uinToUid: (uins: string[]) => Promise<Map<string, string>> },
    missingHint: string,
): Promise<Peer> {
    if (payload.group_id !== undefined) {
        return { chatType: ChatType.GROUP, peerUid: String(payload.group_id) };
    }
    if (payload.user_id !== undefined) {
        const uidMap = await deps.uinToUid([String(payload.user_id)]);
        const uid = uidMap.get(String(payload.user_id));
        if (uid === undefined) {
            throw kernelError(`用户 ${payload.user_id} 的 uid 解析失败`, "INVALID_PARAM");
        }
        return { chatType: ChatType.C2C, peerUid: uid };
    }
    throw kernelError(missingHint, "INVALID_PARAM");
}

/**
 * 按 message_id（OB11 int32 或 NT msgId）拉取单条消息。
 * 消息不存在/已被撤回 → 抛 KernelError NOT_FOUND。
 */
export async function fetchMsgById(
    messageId: number | string,
    messageUnique: MessageUnique,
    msgApi: { fetchMsgsByMsgId: (peer: Peer, msgIds: string[]) => Promise<RawMessage[]> },
): Promise<{ msg: RawMessage; peer: Peer; msgId: string }> {
    const { msgId, peer } = resolveMsgIdAndPeer(messageId, messageUnique);
    const msgs = await msgApi.fetchMsgsByMsgId(peer, [msgId]);
    const [msg] = msgs;
    if (msg === undefined) {
        throw kernelError(`消息 ${messageId} 不存在或已被撤回`, "NOT_FOUND");
    }
    return { msg, peer, msgId };
}
