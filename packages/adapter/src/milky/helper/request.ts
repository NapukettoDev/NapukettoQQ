/**
 * Milky request 事件翻译（通道系，P1 2026-10-30）
 *
 * 事件源（kernel 事件通道，与 OB11 helper/request.ts 同源）：
 *  - Buddy/onBuddyReqChange → friend_request
 *  - Group/onGroupNotifiesUpdated → group_join_request / group_invited_join_request /
 *    group_invitation（type 1=邀请自身 / 5=成员邀请他人 / 7=入群申请，仅未处理状态）
 *
 * 纯函数（ADR-008）：uid→uin 由调用方批量转换后传入。
 * onBuddyReqChange 回调参数形状未经真实事件校准——narrowBuddyReqs 防御性收窄
 * （core/buddy-req.ts，OB11 同源），未知形状返回 null 由调用方打 raw 日志。
 */
import type { BuddyReq, GroupNotify } from "@napuketto/kernel";
import { GroupNotifyMsgStatus, GroupNotifyMsgType } from "@napuketto/kernel";
import { MS_TO_SEC, type RequestTranslateContext, resolveUin } from "../../core/uid-uin.js";
import type {
    FriendRequestData,
    GroupInvitationData,
    GroupInvitedJoinRequestData,
    GroupJoinRequestData,
    MilkyEvent,
} from "../types.js";

/** uid → uin（core 共享解析；ctx 携带映射）。 */
function toUin(uid: string | undefined, ctx: RequestTranslateContext): number {
    return resolveUin(uid, ctx.uidToUin);
}

/** BuddyReq → friend_request 事件（comment 取 words 字段，形状待校准，缺省空串）。 */
export function toFriendRequestEvent(
    req: BuddyReq,
    ctx: RequestTranslateContext,
): MilkyEvent<FriendRequestData> {
    const words = req["words"];
    return {
        time: Math.floor(Date.now() / MS_TO_SEC),
        self_id: Number(ctx.selfUin),
        event_type: "friend_request",
        data: {
            initiator_id: toUin(req.friendUid, ctx),
            initiator_uid: req.friendUid,
            comment: typeof words === "string" ? words : "",
            via: req.sourceName ?? "",
        },
    };
}

/** GroupNotify → Milky 群请求事件（非未处理状态 / 非请求类返回 null）。 */
export function toGroupRequestEvent(
    notify: GroupNotify,
    doubt: boolean,
    ctx: RequestTranslateContext,
): MilkyEvent | null {
    if (notify.status !== GroupNotifyMsgStatus.KUNHANDLE) {
        return null;
    }
    const groupId = Number(notify.group?.groupCode ?? 0);
    const seq = Number(notify.seq);
    const time = Math.floor(Date.now() / MS_TO_SEC);
    const selfId = Number(ctx.selfUin);
    switch (notify.type) {
        case GroupNotifyMsgType.REQUEST_JOIN_NEED_ADMINI_STRATOR_PASS: {
            const data: GroupJoinRequestData = {
                group_id: groupId,
                notification_seq: seq,
                is_filtered: doubt,
                initiator_id: toUin(notify.user1?.uid, ctx),
                comment: notify.postscript ?? "",
            };
            return { time, self_id: selfId, event_type: "group_join_request", data };
        }
        case GroupNotifyMsgType.INVITED_NEED_ADMINI_STRATOR_PASS: {
            // user1=邀请者 / user2=被邀请者（与 OB11 get_group_system_msg 口径一致）
            const data: GroupInvitedJoinRequestData = {
                group_id: groupId,
                notification_seq: seq,
                initiator_id: toUin(notify.user1?.uid, ctx),
                target_user_id: toUin(notify.user2?.uid, ctx),
            };
            return { time, self_id: selfId, event_type: "group_invited_join_request", data };
        }
        case GroupNotifyMsgType.INVITED_BY_MEMBER: {
            const data: GroupInvitationData = {
                group_id: groupId,
                invitation_seq: seq,
                initiator_id: toUin(notify.user1?.uid, ctx),
                source_group_id: null,
            };
            return { time, self_id: selfId, event_type: "group_invitation", data };
        }
        default:
            return null;
    }
}

/**
 * 群通知涉及的 uid 集合（去重；get_group_notifications 与事件广播共用）。
 * kernel GroupEventChannel 的 onGroupNotifiesUpdated 回调参数已类型化
 * （GroupNotify[]），无需防御收窄。
 */
export function collectNotifyUids(notifies: GroupNotify[]): string[] {
    const uids = new Set<string>();
    for (const n of notifies) {
        for (const uid of [n.user1?.uid, n.user2?.uid]) {
            if (uid !== undefined && uid !== "") {
                uids.add(uid);
            }
        }
    }
    return [...uids];
}
