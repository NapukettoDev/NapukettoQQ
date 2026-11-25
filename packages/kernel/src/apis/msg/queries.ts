/**
 * 消息查询公共原语：MsgApi 门面、转发与语音子模块共用——原生 `{ result, msgList }`
 * 解包 → 业务消息数组。
 */
import type { NodeIKernelMsgService, Peer, RawMessage } from "../../types/index.js";
import { unwrapResult } from "../result.js";

/** 按 msgId 批量拉取消息（get_msg / 精华消息 / ptt 转文字共用）。 */
export async function fetchMsgsByMsgId(
    service: NodeIKernelMsgService,
    target: Peer,
    ids: string[],
): Promise<RawMessage[]> {
    if (ids.length === 0) {
        return [];
    }
    const raw = await service.getMsgsByMsgId(target, ids);
    unwrapResult("getMsgsByMsgId", raw);
    return raw.msgList ?? [];
}

/** 拉取历史消息（msgId 为空从最新拉；count 条，时间倒序）。 */
export async function fetchMessages(
    service: NodeIKernelMsgService,
    target: Peer,
    opts: { count: number; msgId?: string },
): Promise<RawMessage[]> {
    const raw = await service.getMsgs(target, opts.msgId ?? "", opts.count, false);
    unwrapResult("getMsgs", raw);
    return raw.msgList ?? [];
}
