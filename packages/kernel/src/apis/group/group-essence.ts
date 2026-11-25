/**
 * 群精华消息：原生 add/removeGroupEssence 需要 msgSeq/msgRandom，先按 msgId 拉消息再提交。
 */
import { kernelError } from "../../infra/index.js";
import type { NodeIKernelGroupService, NodeIKernelMsgService } from "../../types/index.js";
import { ChatType } from "../../types/index.js";
import { checkLooseResult, unwrap } from "../result.js";

/** 设置/取消精华消息（add=true 设置，false 取消）。 */
export async function setGroupEssence(
    msgService: NodeIKernelMsgService,
    groupService: NodeIKernelGroupService,
    groupCode: string,
    msgId: string,
    add: boolean,
): Promise<void> {
    const peer = { chatType: ChatType.GROUP, peerUid: groupCode };
    const raw = await msgService.getMsgsByMsgId(peer, [msgId]);
    unwrap("getMsgsByMsgId", raw.result, raw.errMsg);
    const msg = raw.msgList?.[0];
    if (msg === undefined) {
        throw kernelError(`消息 ${msgId} 不存在`, "NOT_FOUND");
    }
    const param = {
        groupCode,
        msgRandom: Number(msg.msgRandom ?? 0),
        msgSeq: Number(msg.msgSeq),
    };
    let label = "removeGroupEssence";
    let res: unknown;
    if (add) {
        label = "addGroupEssence";
        res = await groupService.addGroupEssence(param);
    } else {
        res = await groupService.removeGroupEssence(param);
    }
    checkLooseResult(label, res);
}
