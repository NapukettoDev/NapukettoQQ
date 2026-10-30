/**
 * OB11 request 事件翻译（2026-09-08）
 *
 * 事件源（kernel 事件通道，本次接线）：
 *  - `Group/onGroupNotifiesUpdated`（GroupBridge，群系统通知推送）→ group_add / group_invite
 *  - `Buddy/onBuddyReqChange`（FriendBridge，好友申请推送）→ friend
 *
 * flag 语义（与应答动作匹配路径一致）：
 *  - 群请求 flag = GroupNotify.seq（set_group_add_request 按 `item.seq === flag` 匹配）
 *  - 好友请求 flag = BuddyReq.reqTime（set_friend_add_request 按 `reqTime === flag` 匹配）
 *
 * 纯函数（ADR-008）：uid→uin 由调用方批量转换后传入。
 * ⚠️ onBuddyReqChange 回调参数形状未经真实事件校准（wrapper 字符串证据仅有方法名），
 * narrowBuddyReqs 防御性收窄，未知形状返回 null 由调用方打 raw 日志积累校准数据。
 */

import {
    type BuddyReq,
    type GroupNotify,
    GroupNotifyMsgStatus,
    GroupNotifyMsgType,
} from "@napuketto/kernel";
import { MS_TO_SEC, type RequestTranslateContext, resolveUin } from "../../core/uid-uin.js";

export type { RequestTranslateContext } from "../../core/uid-uin.js";

import type { OB11FriendRequestEvent, OB11GroupRequestEvent } from "../event/index.js";

/** uid → uin（core 共享解析；ctx 携带映射）。 */
function toUin(uid: string | undefined, ctx: RequestTranslateContext): number {
    return resolveUin(uid, ctx.uidToUin);
}

/**
 * GroupNotify → OB11 群请求事件（group_add / group_invite）。
 *
 * type 语义与 get_group_system_msg 动作同一解释：1/5=邀请（invite）、7=申请（add）；
 * 仅未处理状态（KUNHANDLE）推送——已处理通知重复推送不再发事件。
 * 非请求类通知（踢人/转让等处理结果回执）返回 null。
 */
export function toOb11GroupRequestEvent(
    notify: GroupNotify,
    ctx: RequestTranslateContext,
): OB11GroupRequestEvent | null {
    if (notify.status !== GroupNotifyMsgStatus.KUNHANDLE) {
        return null;
    }
    let subType: "add" | "invite";
    switch (notify.type) {
        case GroupNotifyMsgType.INVITED_BY_MEMBER:
        case GroupNotifyMsgType.INVITED_NEED_ADMINI_STRATOR_PASS:
            subType = "invite";
            break;
        case GroupNotifyMsgType.REQUEST_JOIN_NEED_ADMINI_STRATOR_PASS:
            subType = "add";
            break;
        default:
            return null;
    }
    // user1 语义：invite=邀请人 / add=申请人（与 get_group_system_msg 的 invitor 口径一致）
    return {
        time: Math.floor(Date.now() / MS_TO_SEC),
        self_id: Number(ctx.selfUin),
        post_type: "request",
        request_type: "group",
        sub_type: subType,
        group_id: Number(notify.group?.groupCode ?? 0),
        user_id: toUin(notify.user1?.uid, ctx),
        comment: notify.postscript ?? "",
        flag: String(notify.seq),
    };
}

/** BuddyReq 防御性收窄收敛到 core（OB11 / Milky 共用，P1 2026-10-30）。 */
export { isBuddyReqLike, narrowBuddyReqs } from "../../core/buddy-req.js";

/**
 * BuddyReq → OB11 好友请求事件（friend）。
 * comment 取 words 字段（验证留言，形状待校准，缺省空串）；flag = reqTime。
 */
export function toOb11FriendRequestEvent(
    req: BuddyReq,
    ctx: RequestTranslateContext,
): OB11FriendRequestEvent {
    const words = req["words"];
    return {
        time: Math.floor(Date.now() / MS_TO_SEC),
        self_id: Number(ctx.selfUin),
        post_type: "request",
        request_type: "friend",
        user_id: toUin(req.friendUid, ctx),
        comment: typeof words === "string" ? words : "",
        flag: req.reqTime,
    };
}
