/**
 * Milky notice 事件翻译测试（P1 grayTip 系）
 *
 * 锁定：成员增加（approve/invite 两形态）/ 减少（踢/退）/ 禁言 / 全员禁言 /
 * 改名 / 解散（操作者缺失不产出）/ 戳一戳（群/好友）/ 未知子类型返回 null。
 */
import {
    ChatType,
    type GrayTipElement,
    GrayTipSubType,
    type RawMessage,
    TipGroupElementType,
} from "@napuketto/kernel";
import { describe, expect, it, vi } from "vitest";
import { toMilkyNoticeEvent } from "./notice.js";

/** uid→uin 映射（测试固定三对）。 */
const UID_TO_UIN = new Map([
    ["uid-10001", "10001"],
    ["uid-20002", "20002"],
    ["uid-30003", "30003"],
]);

/** 构造含单个 grayTip 的群消息。 */
function groupMsg(grayTip: GrayTipElement): RawMessage {
    return {
        msgId: "m1",
        msgSeq: "1300",
        msgTime: "1760000000000",
        msgType: 0,
        chatType: ChatType.GROUP,
        peerUid: "10001",
        peerUin: "10001",
        senderUid: "uid-10001",
        senderUin: "10001",
        peerName: "群",
        sendNickName: "n",
        elements: [{ elementType: 8, grayTipElement: grayTip }],
    };
}

function ctx() {
    return {
        selfUin: "10000",
        uidToUin: UID_TO_UIN,
        logger: { warn: vi.fn() },
    };
}

describe("toMilkyNoticeEvent", () => {
    it("成员增加（管理员同意）：operator_id 有值、invitor_id 为 null", () => {
        const event = toMilkyNoticeEvent(
            groupMsg({
                subElementType: GrayTipSubType.GROUP,
                groupElement: {
                    type: TipGroupElementType.MEMBER_ADD,
                    memberUid: "uid-20002",
                    adminUid: "uid-20002",
                },
            }),
            ctx(),
        );
        expect(event).toMatchObject({
            time: 1760000000,
            self_id: 10000,
            event_type: "group_member_increase",
            data: { group_id: 10001, user_id: 20002, operator_id: 20002, invitor_id: null },
        });
    });

    it("成员增加（邀请入群）：invitor_id 有值、operator_id 为 null", () => {
        const event = toMilkyNoticeEvent(
            groupMsg({
                subElementType: GrayTipSubType.GROUP,
                groupElement: {
                    type: TipGroupElementType.MEMBER_ADD,
                    memberUid: "uid-20002",
                    adminUid: "uid-30003",
                },
            }),
            ctx(),
        );
        expect(event?.event_type).toBe("group_member_increase");
        expect(event?.data).toMatchObject({ user_id: 20002, operator_id: null, invitor_id: 30003 });
    });

    it("成员减少（被踢）：operator_id 与本人不同", () => {
        const event = toMilkyNoticeEvent(
            groupMsg({
                subElementType: GrayTipSubType.GROUP,
                groupElement: {
                    type: TipGroupElementType.QUIT,
                    memberUid: "uid-20002",
                    adminUid: "uid-30003",
                },
            }),
            ctx(),
        );
        expect(event?.event_type).toBe("group_member_decrease");
        expect(event?.data).toMatchObject({ user_id: 20002, operator_id: 30003 });
    });

    it("成员减少（主动退群）：operator_id 为 null", () => {
        const event = toMilkyNoticeEvent(
            groupMsg({
                subElementType: GrayTipSubType.GROUP,
                groupElement: { type: TipGroupElementType.QUIT, memberUid: "uid-20002" },
            }),
            ctx(),
        );
        expect(event?.data).toMatchObject({ user_id: 20002, operator_id: null });
    });

    it("禁言：member 非空 → group_mute（duration 秒）", () => {
        const event = toMilkyNoticeEvent(
            groupMsg({
                subElementType: GrayTipSubType.GROUP,
                groupElement: {
                    type: TipGroupElementType.SHUT_UP,
                    shutUp: {
                        duration: "600",
                        admin: { uid: "uid-30003" },
                        member: { uid: "uid-20002" },
                    },
                },
            }),
            ctx(),
        );
        expect(event?.event_type).toBe("group_mute");
        expect(event?.data).toMatchObject({
            group_id: 10001,
            user_id: 20002,
            operator_id: 30003,
            duration: 600,
        });
    });

    it("全员禁言：member 空 → group_whole_mute（is_mute=true）", () => {
        const event = toMilkyNoticeEvent(
            groupMsg({
                subElementType: GrayTipSubType.GROUP,
                groupElement: {
                    type: TipGroupElementType.SHUT_UP,
                    shutUp: { duration: "600", admin: { uid: "uid-30003" } },
                },
            }),
            ctx(),
        );
        expect(event?.event_type).toBe("group_whole_mute");
        expect(event?.data).toMatchObject({ group_id: 10001, operator_id: 30003, is_mute: true });
    });

    it("改名：操作者可得时产出 group_name_change", () => {
        const event = toMilkyNoticeEvent(
            groupMsg({
                subElementType: GrayTipSubType.GROUP,
                groupElement: {
                    type: TipGroupElementType.GROUP_NAME_MODIFIED,
                    groupName: "新群名",
                    adminUid: "uid-30003",
                },
            }),
            ctx(),
        );
        expect(event?.event_type).toBe("group_name_change");
        expect(event?.data).toMatchObject({
            group_id: 10001,
            new_group_name: "新群名",
            operator_id: 30003,
        });
    });

    it("解散：操作者缺失时不产出（schema operator_id 下限守卫）", () => {
        const event = toMilkyNoticeEvent(
            groupMsg({
                subElementType: GrayTipSubType.GROUP,
                groupElement: { type: TipGroupElementType.DISBANDED },
            }),
            ctx(),
        );
        expect(event).toBeNull();
    });

    it("群戳一戳：aioOp → group_nudge（receiver 取 aioOp.peerUid）", () => {
        const event = toMilkyNoticeEvent(
            groupMsg({
                subElementType: GrayTipSubType.GROUP,
                aioOpGrayTipElement: { operateType: 6, peerUid: "uid-20002" },
            }),
            ctx(),
        );
        expect(event?.event_type).toBe("group_nudge");
        expect(event?.data).toMatchObject({
            group_id: 10001,
            sender_id: 10001,
            receiver_id: 20002,
            display_action: "",
        });
    });

    it("好友戳一戳：aioOp → friend_nudge（is_self_receive 对端发时为 true）", () => {
        const msg = groupMsg({
            subElementType: GrayTipSubType.BUDDY_NOTIFY,
            aioOpGrayTipElement: { operateType: 6, peerUid: "uid-10000" },
        });
        const event = toMilkyNoticeEvent({ ...msg, chatType: ChatType.C2C }, ctx());
        expect(event?.event_type).toBe("friend_nudge");
        expect(event?.data).toMatchObject({
            user_id: 10001,
            is_self_send: false,
            is_self_receive: true,
        });
    });

    it("未知子类型：返回 null 并打 raw 校准日志", () => {
        const logger = ctx();
        const event = toMilkyNoticeEvent(
            groupMsg({
                subElementType: GrayTipSubType.JSON,
                jsonGrayTipElement: { jsonStr: "{}" },
            }),
            logger,
        );
        expect(event).toBeNull();
        expect(logger.logger.warn).toHaveBeenCalled();
    });
});
