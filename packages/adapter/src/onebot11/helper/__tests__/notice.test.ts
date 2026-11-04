/**
 * notice.test.ts：OB11 notice 翻译单测（2026-09-08 T4 补全；本轮补 group_decrease /
 * group_admin / group_ban / 防御分支）。
 *
 * 覆盖：group_recall（既有）、friend_recall（C2C 撤回，新）、notify.poke
 * （aioOp，新——待真实事件验证）、未知 grayTip 子类型 raw 日志、群成员变动既有口径。
 */
import { ChatType, GrayTipSubType, type RawMessage, TipGroupElementType } from "@napuketto/kernel";
import { describe, expect, it, vi } from "vitest";
import { hasFileElement, toFriendAdd, toGroupUpload, toOb11NoticeEvent } from "../notice.js";

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

    it("aioOp 缺 peerUid → target_id=0 兜底（空串不硬转）", () => {
        const event = toOb11NoticeEvent(
            groupMsg({
                subElementType: GrayTipSubType.BUDDY_NOTIFY,
                aioOpGrayTipElement: { operateType: 1 },
            }),
            CTX,
        );
        expect(event).toMatchObject({ notice_type: "notify", sub_type: "poke", target_id: 0 });
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

    it("groupElement 缺 memberUid/adminUid → 空串兜底（approve 判定 + user_id=0）", () => {
        const event = toOb11NoticeEvent(
            groupMsg({ subElementType: GrayTipSubType.GROUP, groupElement: { type: 1 } }),
            CTX,
        );
        expect(event).toMatchObject({
            notice_type: "group_increase",
            sub_type: "approve",
            operator_id: 0,
            user_id: 0,
        });
    });

    it("QUIT → group_decrease leave（operator=管理员、user_id=成员）", () => {
        const wideCtx = {
            ...CTX,
            uidToUin: new Map([
                ["u9", "90009"],
                ["u1", "90001"],
            ]),
        };
        const event = toOb11NoticeEvent(
            groupMsg({
                subElementType: GrayTipSubType.GROUP,
                groupElement: { type: TipGroupElementType.QUIT, memberUid: "u9", adminUid: "u1" },
            }),
            wideCtx,
        );
        expect(event).toMatchObject({
            notice_type: "group_decrease",
            sub_type: "leave",
            group_id: 808,
            operator_id: 90001,
            user_id: 90009,
        });
    });

    it("BLOCK → group_admin set；UNBLOCK → unset（memberUid 空回退 adminUid）", () => {
        const setEvent = toOb11NoticeEvent(
            groupMsg({
                subElementType: GrayTipSubType.GROUP,
                groupElement: { type: TipGroupElementType.BLOCK, memberUid: "u9", adminUid: "u1" },
            }),
            CTX,
        );
        expect(setEvent).toMatchObject({
            notice_type: "group_admin",
            sub_type: "set",
            user_id: 90009,
        });
        const unsetEvent = toOb11NoticeEvent(
            groupMsg({
                subElementType: GrayTipSubType.GROUP,
                groupElement: { type: TipGroupElementType.UNBLOCK, memberUid: "", adminUid: "u9" },
            }),
            CTX,
        );
        expect(unsetEvent).toMatchObject({
            notice_type: "group_admin",
            sub_type: "unset",
            user_id: 90009,
        });
    });

    it("SHUT_UP → group_ban（duration>0=ban / 0=lift_ban；shutUp 优先于公共 uid）", () => {
        const wideCtx = {
            ...CTX,
            uidToUin: new Map([
                ["u9", "90009"],
                ["u1", "90001"],
            ]),
        };
        const banEvent = toOb11NoticeEvent(
            groupMsg({
                subElementType: GrayTipSubType.GROUP,
                groupElement: {
                    type: TipGroupElementType.SHUT_UP,
                    memberUid: "u9",
                    adminUid: "u1",
                    shutUp: { duration: "600", admin: { uid: "u1" }, member: { uid: "u9" } },
                },
            }),
            wideCtx,
        );
        expect(banEvent).toMatchObject({
            notice_type: "group_ban",
            sub_type: "ban",
            operator_id: 90001,
            user_id: 90009,
            duration: 600,
        });
        const liftEvent = toOb11NoticeEvent(
            groupMsg({
                subElementType: GrayTipSubType.GROUP,
                groupElement: {
                    type: TipGroupElementType.SHUT_UP,
                    memberUid: "u9",
                    adminUid: "u1",
                },
            }),
            wideCtx,
        );
        expect(liftEvent).toMatchObject({
            notice_type: "group_ban",
            sub_type: "lift_ban",
            duration: 0,
            operator_id: 90001,
            user_id: 90009,
        });
    });

    it("GROUP 子类型但 groupElement 缺失 → null；type 无映射器（DISBANDED 等）→ null", () => {
        expect(
            toOb11NoticeEvent(groupMsg({ subElementType: GrayTipSubType.GROUP }), CTX),
        ).toBeNull();
        expect(
            toOb11NoticeEvent(
                groupMsg({
                    subElementType: GrayTipSubType.GROUP,
                    groupElement: { type: TipGroupElementType.DISBANDED },
                }),
                CTX,
            ),
        ).toBeNull();
    });

    it("REVOKE 子类型但 revokeElement 缺失 → null", () => {
        expect(
            toOb11NoticeEvent(groupMsg({ subElementType: GrayTipSubType.REVOKE }), CTX),
        ).toBeNull();
    });
});

describe("toOb11NoticeEvent：多元素扫描", () => {
    it("非 grayTip 元素在前 → 跳过继续扫描（首个 grayTip 生效）", () => {
        const msg = {
            ...groupMsg({
                subElementType: GrayTipSubType.REVOKE,
                revokeElement: { operatorUid: "u9" },
            }),
            elements: [
                { elementType: 1, textElement: { content: "前缀" } },
                {
                    elementType: 8,
                    grayTipElement: {
                        subElementType: GrayTipSubType.REVOKE,
                        revokeElement: { operatorUid: "u9" },
                    },
                },
            ],
        } as unknown as RawMessage;
        expect(toOb11NoticeEvent(msg, CTX)).toMatchObject({ notice_type: "group_recall" });
    });
});

describe("hasFileElement / toGroupUpload（B4 group_upload）", () => {
    /** 群文件消息桩。 */
    function fileMsg(): RawMessage {
        return {
            msgId: "9100",
            msgSeq: "9",
            msgTime: "1700000000000",
            chatType: ChatType.GROUP,
            peerUid: "808",
            senderUin: "90009",
            elements: [
                {
                    elementType: 3,
                    fileElement: { fileName: "doc.pdf", fileSize: "1024", fileUuid: "uuid-1" },
                },
            ],
        } as unknown as RawMessage;
    }

    it("hasFileElement 判定 fileElement 存在性", () => {
        expect(hasFileElement(fileMsg())).toBe(true);
        const plain = { ...fileMsg(), elements: [{ elementType: 1 }] } as unknown as RawMessage;
        expect(hasFileElement(plain)).toBe(false);
    });

    it("toGroupUpload → file{id=fileUuid, name, size, busid=102}", () => {
        const event = toGroupUpload(fileMsg(), "10001");
        expect(event).toMatchObject({
            post_type: "notice",
            notice_type: "group_upload",
            group_id: 808,
            user_id: 90009,
            file: { id: "uuid-1", name: "doc.pdf", size: 1024, busid: 102 },
        });
    });

    it("无 fileElement → null；fileUuid 缺失回退文件名", () => {
        expect(
            toGroupUpload({ ...fileMsg(), elements: [] } as unknown as RawMessage, "10001"),
        ).toBeNull();
        // fileUuid 与 fileName 都缺失 → id/name 空串兜底
        const bare = {
            ...fileMsg(),
            elements: [{ elementType: 3, fileElement: { fileSize: "5" } }],
        } as unknown as RawMessage;
        expect(toGroupUpload(bare, "10001")?.file).toEqual({
            id: "",
            name: "",
            size: 5,
            busid: 102,
        });
        const noUuid = {
            ...fileMsg(),
            elements: [{ elementType: 3, fileElement: { fileName: "x.zip" } }],
        } as unknown as RawMessage;
        expect(toGroupUpload(noUuid, "10001")?.file.id).toBe("x.zip");
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
