/**
 * notice.test.ts：OB11 notice 翻译单测（2026-09-08 T4 补全）。
 *
 * 覆盖：group_recall（既有）、friend_recall（C2C 撤回，新）、notify.poke
 * （aioOp，新——待真实事件验证）、未知 grayTip 子类型 raw 日志、群成员变动既有口径。
 */
import { ChatType, GrayTipSubType, type RawMessage } from "@napuketto/kernel";
import { describe, expect, it, vi } from "vitest";
import { toFriendAdd, toOb11NoticeEvent } from "../notice.js";

const CTX = { selfUin: "10001", uidToUin: new Map([["u9", "90009"]]) };

/** 群消息工厂（单 grayTip 元素）。 */
function groupMsg(grayTip: Record<string, unknown>): RawMessage {
    return {
        msgId: "6800",
        msgSeq: "42",
        msgTime: "1700000000000",
        msgType: 5,
        chatType: ChatType.GROUP,
        peerUid: "808",
        peerUin: "808",
        senderUid: "u9",
        senderUin: "90009",
        peerName: "群",
        sendNickName: "某人",
        elements: [{ elementType: 8, grayTipElement: grayTip }],
    } as unknown as RawMessage;
}

describe("toOb11NoticeEvent：撤回", () => {
    it("群撤回 → group_recall（既有口径不变）", () => {
        const event = toOb11NoticeEvent(
            groupMsg({
                subElementType: GrayTipSubType.REVOKE,
                revokeElement: { operatorUid: "u9" },
            }),
            CTX,
        );
        expect(event).toMatchObject({
            post_type: "notice",
            notice_type: "group_recall",
            group_id: 808,
            user_id: 90009,
            message_id: 42,
        });
    });

    it("好友撤回（C2C REVOKE）→ friend_recall（2026-09-08 新增）", () => {
        const msg = groupMsg({
            subElementType: GrayTipSubType.REVOKE,
            revokeElement: { operatorUid: "u9" },
        });
        msg.chatType = ChatType.C2C;
        const event = toOb11NoticeEvent(msg, CTX);
        expect(event).toMatchObject({
            post_type: "notice",
            notice_type: "friend_recall",
            user_id: 90009,
            message_id: 42,
        });
    });
});

describe("toOb11NoticeEvent：poke（aioOp，待真实事件验证）", () => {
    it("群内 poke → notify.poke（group_id=群号，raw 校准日志始终打）", () => {
        const logger = { warn: vi.fn(), info: vi.fn() };
        const event = toOb11NoticeEvent(
            groupMsg({
                subElementType: GrayTipSubType.BUDDY_NOTIFY,
                aioOpGrayTipElement: { operateType: 1, peerUid: "u9" },
            }),
            { ...CTX, logger },
        );
        expect(event).toMatchObject({
            post_type: "notice",
            notice_type: "notify",
            sub_type: "poke",
            group_id: 808,
            user_id: 90009,
            target_id: 90009,
        });
        expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it("C2C poke → group_id=0", () => {
        const msg = groupMsg({ aioOpGrayTipElement: { peerUid: "u9" } });
        msg.chatType = ChatType.C2C;
        const event = toOb11NoticeEvent(msg, CTX);
        expect(event).toMatchObject({ notice_type: "notify", sub_type: "poke", group_id: 0 });
    });
});

describe("toOb11NoticeEvent：未知子类型 raw 日志", () => {
    it("未翻译子类型（JSON）→ 无事件 + raw 日志（校准数据）", () => {
        const logger = { warn: vi.fn(), info: vi.fn() };
        const event = toOb11NoticeEvent(
            groupMsg({
                subElementType: GrayTipSubType.JSON,
                jsonGrayTipElement: { busiId: "1061", jsonStr: "{}" },
            }),
            { ...CTX, logger },
        );
        expect(event).toBeNull();
        expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it("logger 缺省静默不抛", () => {
        const event = toOb11NoticeEvent(groupMsg({ subElementType: GrayTipSubType.ESSENCE }), CTX);
        expect(event).toBeNull();
    });
});

describe("toOb11NoticeEvent：群成员变动（既有口径回归）", () => {
    it("MEMBER_ADD → group_increase", () => {
        const event = toOb11NoticeEvent(
            groupMsg({
                subElementType: GrayTipSubType.GROUP,
                groupElement: { type: 1, memberUid: "u9", adminUid: "u1" },
            }),
            CTX,
        );
        expect(event).toMatchObject({ notice_type: "group_increase", sub_type: "invite" });
    });
});

describe("toFriendAdd（B2，快照 diff 源）", () => {
    it("coreInfo.uin 优先 → friend_add(user_id)", () => {
        const event = toFriendAdd(
            { uid: "u1", uin: "1", coreInfo: { uid: "u1", uin: "10086", nick: "n" } },
            "10001",
        );
        expect(event).toMatchObject({
            post_type: "notice",
            notice_type: "friend_add",
            self_id: 10001,
            user_id: 10086,
        });
    });

    it("coreInfo 缺失回退顶层 uin;全缺 user_id=NaN 容忍(不抛错)", () => {
        expect(toFriendAdd({ uid: "u1", uin: "10087" }, "10001").user_id).toBe(10087);
        expect(toFriendAdd({ uid: "u1" }, "10001").post_type).toBe("notice");
    });
});
