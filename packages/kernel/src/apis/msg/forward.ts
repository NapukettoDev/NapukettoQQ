/**
 * 转发消息：合并转发（buildMultiForwardMsg / getMultiMsg）与单条转发（forwardMsg）。
 */
import { kernelError } from "../../infra/index.js";
import type { NodeIKernelMsgService, Peer, RawMessage } from "../../types/index.js";
import { unwrapResult } from "../result.js";
import { fetchMsgsByMsgId } from "./queries.js";

/**
 * 在消息列表中找含 multiForwardMsgElement 的元素（找不到返回 null）。
 * 同 findPttElement：`!= null` 兼容 Linux 的显式 null 变体字段。
 */
function findForwardElement(
    msgs: RawMessage[],
): { resId: string; fileName: string; xmlContent: string } | null {
    const [first] = msgs;
    if (first === undefined) {
        return null;
    }
    return (
        first.elements.find((el) => el.multiForwardMsgElement != null)?.multiForwardMsgElement ??
        null
    );
}

/**
 * 发送合并转发（send_group/private_forward_msg）。
 * buildMultiForwardMsg 组装 MULTI_FORWARD 元素 → 直接作 sendMsg 元素发送。
 */
export async function sendForwardMessage(
    service: NodeIKernelMsgService,
    target: Peer,
    sourcePeer: Peer,
    srcMsgIds: string[],
): Promise<{ msgId: string }> {
    if (srcMsgIds.length === 0) {
        throw kernelError("sendForwardMessage 需要至少一条源消息", "INVALID_PARAM");
    }
    const built = await service.buildMultiForwardMsg({
        srcMsgIds,
        srcContact: sourcePeer,
    });
    unwrapResult("buildMultiForwardMsg", built);
    const elements = built.rspInfo?.elements;
    // Linux 原生宿主可能给显式 null 而不是省略（统一空值判据）
    if (elements == null || elements.length === 0) {
        throw kernelError("合并转发组装失败：无元素", "UNKNOWN");
    }
    const msgId = service.generateMsgUniqueId(target.chatType, String(Date.now()));
    const raw = await service.sendMsg(msgId, target, elements, new Map());
    unwrapResult("sendMsg", raw);
    return { msgId };
}

/** 获取合并转发内容（get_forward_msg；resId 取自 multiForwardMsgElement）。 */
export async function fetchForwardMessage(
    service: NodeIKernelMsgService,
    peer: Peer,
    msgId: string,
): Promise<RawMessage[]> {
    const msgs = await fetchMsgsByMsgId(service, peer, [msgId]);
    const forward = findForwardElement(msgs);
    // resId 在 Linux 原生对象上可能是显式 null（空值判据）
    if (forward === null || forward.resId == null || forward.resId === "") {
        throw kernelError("消息不包含合并转发内容", "NOT_FOUND");
    }
    const raw = await service.getMultiMsg(peer, msgId, forward.resId);
    unwrapResult("getMultiMsg", raw);
    return raw.msgList ?? [];
}

/** 单条转发（forward_group/friend_single_msg；srcMsgIds 源、dstPeer 目标）。 */
export async function forwardSingleMessage(
    service: NodeIKernelMsgService,
    sourcePeer: Peer,
    srcMsgIds: string[],
    dstPeer: Peer,
): Promise<void> {
    if (srcMsgIds.length === 0) {
        throw kernelError("forwardSingleMessage 需要至少一条源消息", "INVALID_PARAM");
    }
    const raw = await service.forwardMsg(srcMsgIds, sourcePeer, [dstPeer], undefined);
    unwrapResult("forwardMsg", raw);
}
