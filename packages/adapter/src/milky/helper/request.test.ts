/**
 * Milky request 事件翻译测试（P1 通道系）
 *
 * 锁定：好友申请事件（words → comment）/ 入群申请（type 7）/ 成员邀请他人
 * （type 5）/ 邀请自身（type 1）/ 已处理状态过滤 / 非请求类返回 null。
 */
import type { BuddyReq, GroupNotify } from "@napuketto/kernel";
import { GroupNotifyMsgStatus, GroupNotifyMsgType } from "@napuketto/kernel";
import { describe, expect, it } from "vitest";
import { toFriendRequestEvent, toGroupRequestEvent } from "./request.js";

const UID_TO_UIN = new Map([
    ["uid-10001", "10001"],
    ["uid-20002", "20002"],
    ["uid-30003", "30003"],
]);

const CTX = { selfUin: "10000", uidToUin: UID_TO_UIN };

function notify(
    type: GroupNotifyMsgType,
    status: GroupNotifyMsgStatus = GroupNotifyMsgStatus.KUNHANDLE,
): GroupNotify {
    return {
        seq: "88001",
        type,
        status,
        group: { groupCode: "10001", groupName: "群" },
        user1: { uid: "uid-20002", nickName: "甲" },
        user2: { uid: "uid-30003", nickName: "乙" },
        postscript: "求入",
    };
}

describe("toFriendRequestEvent", () => {
    it("friend_request：initiator_id 经 uid→uin，comment 取 words", () => {
        const req = {
            reqTime: "1760000000",
            friendUid: "uid-20002",
            friendNick: "甲",
            sourceName: "搜索",
            words: "加个好友",
        } as unknown as BuddyReq;
        const event = toFriendRequestEvent(req, CTX);
        expect(event).toMatchObject({
            time: expect.any(Number),
            self_id: 10000,
            event_type: "friend_request",
            data: {
                initiator_id: 20002,
                initiator_uid: "uid-20002",
                comment: "加个好友",
                via: "搜索",
            },
        });
    });
});

describe("toGroupRequestEvent", () => {
    it("type 7 → group_join_request（is_filtered 透传 doubt）", () => {
        const event = toGroupRequestEvent(
            notify(GroupNotifyMsgType.REQUEST_JOIN_NEED_ADMINI_STRATOR_PASS),
            true,
            CTX,
        );
        expect(event).toMatchObject({
            self_id: 10000,
            event_type: "group_join_request",
            data: {
                group_id: 10001,
                notification_seq: 88001,
                is_filtered: true,
                initiator_id: 20002,
                comment: "求入",
            },
        });
    });

    it("type 5 → group_invited_join_request（user1=邀请者 / user2=被邀请者）", () => {
        const event = toGroupRequestEvent(
            notify(GroupNotifyMsgType.INVITED_NEED_ADMINI_STRATOR_PASS),
            false,
            CTX,
        );
        expect(event?.event_type).toBe("group_invited_join_request");
        expect(event?.data).toMatchObject({
            group_id: 10001,
            notification_seq: 88001,
            initiator_id: 20002,
            target_user_id: 30003,
        });
    });

    it("type 1 → group_invitation（invitation_seq + source_group_id null）", () => {
        const event = toGroupRequestEvent(notify(GroupNotifyMsgType.INVITED_BY_MEMBER), false, CTX);
        expect(event?.event_type).toBe("group_invitation");
        expect(event?.data).toMatchObject({
            group_id: 10001,
            invitation_seq: 88001,
            initiator_id: 20002,
            source_group_id: null,
        });
    });

    it("已处理状态（KINIT）不推送", () => {
        const event = toGroupRequestEvent(
            notify(
                GroupNotifyMsgType.REQUEST_JOIN_NEED_ADMINI_STRATOR_PASS,
                GroupNotifyMsgStatus.KINIT,
            ),
            false,
            CTX,
        );
        expect(event).toBeNull();
    });

    it("非请求类通知（SET_ADMIN）返回 null", () => {
        const event = toGroupRequestEvent(notify(GroupNotifyMsgType.SET_ADMIN), false, CTX);
        expect(event).toBeNull();
    });
});
