/**
 * request.ts 单测：OB11 request 事件翻译（群通知/好友申请 → request 事件）。
 *
 * 覆盖：
 *  - GroupNotify → group_add / group_invite（type 7/1/5），已处理/非请求类型过滤
 *  - BuddyReq → friend（flag=reqTime、words→comment）
 *  - narrowBuddyReqs 防御性收窄（数组 / {buddyReqs} / 未知形状）
 */
import type { BuddyReq, GroupNotify } from "@napuketto/kernel";
import { GroupNotifyMsgStatus, GroupNotifyMsgType } from "@napuketto/kernel";
import { describe, expect, it } from "vitest";
import {
    isBuddyReqLike,
    narrowBuddyReqs,
    toOb11FriendRequestEvent,
    toOb11GroupRequestEvent,
} from "../request.js";

const CTX = { selfUin: "10001", uidToUin: new Map([["u9", "90009"]]) };

function makeNotify(overrides: Partial<GroupNotify> = {}): GroupNotify {
    return {
        seq: "1024",
        type: GroupNotifyMsgType.REQUEST_JOIN_NEED_ADMINI_STRATOR_PASS,
        status: GroupNotifyMsgStatus.KUNHANDLE,
        group: { groupCode: "808", groupName: "测试群" },
        user1: { uid: "u9", nickName: "申请人" },
        user2: { uid: "u1", nickName: "审批人" },
        postscript: "请通过",
        ...overrides,
    };
}

describe("toOb11GroupRequestEvent", () => {
    it("type 7（申请入群）→ group_add，flag=seq，user_id=user1", () => {
        const event = toOb11GroupRequestEvent(makeNotify(), CTX);
        expect(event).toMatchObject({
            post_type: "request",
            request_type: "group",
            sub_type: "add",
            group_id: 808,
            user_id: 90009,
            comment: "请通过",
            flag: "1024",
            self_id: 10001,
        });
    });

    it("type 1 / type 5（邀请）→ group_invite", () => {
        for (const type of [
            GroupNotifyMsgType.INVITED_BY_MEMBER,
            GroupNotifyMsgType.INVITED_NEED_ADMINI_STRATOR_PASS,
        ]) {
            const event = toOb11GroupRequestEvent(makeNotify({ type }), CTX);
            expect(event?.sub_type).toBe("invite");
        }
    });

    it("group / postscript 缺失 → group_id=0、comment 空串兜底", () => {
        const notify = makeNotify({ status: GroupNotifyMsgStatus.KUNHANDLE });
        // delete 模拟字段缺失（exactOptionalPropertyTypes 下不能显式 undefined）
        delete (notify as { group?: unknown }).group;
        delete (notify as { postscript?: unknown }).postscript;
        const event = toOb11GroupRequestEvent(notify, CTX);
        expect(event).toMatchObject({ request_type: "group", group_id: 0, comment: "" });
    });

    it("已处理状态（非 KUNHANDLE）不产生事件", () => {
        const event = toOb11GroupRequestEvent(
            makeNotify({ status: GroupNotifyMsgStatus.KAGREED }),
            CTX,
        );
        expect(event).toBeNull();
    });

    it("非请求类型（如 SET_ADMIN）不产生事件", () => {
        const event = toOb11GroupRequestEvent(
            makeNotify({ type: GroupNotifyMsgType.SET_ADMIN }),
            CTX,
        );
        expect(event).toBeNull();
    });

    it("uid 映射缺失：非数字 uid 返回 0（未知），数字 uid 直取", () => {
        const event = toOb11GroupRequestEvent(
            makeNotify({ user1: { uid: "u404", nickName: "未知" } }),
            CTX,
        );
        expect(event?.user_id).toBe(0);
        const numeric = toOb11GroupRequestEvent(
            makeNotify({ user1: { uid: "123456", nickName: "数字uid" } }),
            CTX,
        );
        expect(numeric?.user_id).toBe(123456);
    });
});

describe("narrowBuddyReqs / isBuddyReqLike", () => {
    const req: BuddyReq = {
        reqTime: "1725800000",
        friendUid: "u9",
        friendNick: "新朋友",
        words: "你好",
    };

    it("BuddyReq[] 直接收窄", () => {
        expect(narrowBuddyReqs([req])).toEqual([req]);
    });

    it("{ buddyReqs: [...] } 收窄", () => {
        expect(narrowBuddyReqs({ buddyReqs: [req] })).toEqual([req]);
    });

    it("未知形状返回 null（调用方打 raw 日志）", () => {
        expect(narrowBuddyReqs({ foo: 1 })).toBeNull();
        expect(narrowBuddyReqs("x")).toBeNull();
        expect(narrowBuddyReqs([{ reqTime: 1, friendUid: "u9" }])).toBeNull();
    });

    it("isBuddyReqLike 校验必填字段", () => {
        expect(isBuddyReqLike(req)).toBe(true);
        expect(isBuddyReqLike({ reqTime: "1" })).toBe(false);
        expect(isBuddyReqLike(null)).toBe(false);
    });
});

describe("toOb11FriendRequestEvent", () => {
    it("BuddyReq → friend request（flag=reqTime，words→comment，uid→uin）", () => {
        const event = toOb11FriendRequestEvent(
            { reqTime: "1725800000", friendUid: "u9", friendNick: "新朋友", words: "加个好友" },
            CTX,
        );
        expect(event).toMatchObject({
            post_type: "request",
            request_type: "friend",
            user_id: 90009,
            comment: "加个好友",
            flag: "1725800000",
        });
    });

    it("words 缺省 comment 为空串（字段形状待真实事件校准）", () => {
        const event = toOb11FriendRequestEvent({ reqTime: "1725800001", friendUid: "u9" }, CTX);
        expect(event.comment).toBe("");
    });
});
