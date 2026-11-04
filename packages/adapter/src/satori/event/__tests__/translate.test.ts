/**
 * event/translate.test.ts：kernel RawMessage → Satori 事件内容翻译单测。
 *
 * 锁定四类行为：
 *  - toSatoriMessageEvent：message-created（资源提升自 helper/toSatoriMessage）
 *  - hasSatoriGrayTip：REVOKE / GROUP 命中，其余子类型与普通元素不命中
 *  - toSatoriGrayTipEvent：message-deleted（撤回，operator uid→uin）、
 *    guild-member-added / removed（member/user/operator 构造）、
 *    非 GROUP 会话的成员变动忽略、未知类型返回 null
 *  - collectSatoriGrayTipUids：core 共享实现的 re-export 契约
 */
import { ChatType, GrayTipSubType, TipGroupElementType } from "@napuketto/kernel";
import { describe, expect, it } from "vitest";
import { makeMemberChangeMsg, makeRawMsg, makeRevokeMsg } from "../../__tests__/test-support.js";
import {
    collectSatoriGrayTipUids,
    hasSatoriGrayTip,
    toSatoriGrayTipEvent,
    toSatoriMessageEvent,
} from "../translate.js";

/** uid → uin 映射（测试用固定表）。 */
const UIN_MAP = new Map([
    ["op-uid-1", "80001"],
    ["member-uid-1", "91001"],
    ["admin-uid-1", "92001"],
]);

describe("toSatoriMessageEvent", () => {
    it("群聊消息 → message-created（channel/guild/user/member 平铺）", async () => {
        const content = await toSatoriMessageEvent(makeRawMsg(), { selfUin: "10001" });
        expect(content.type).toBe("message-created");
        expect(content.timestamp).toBe(1700000000);
        expect(content.guild).toEqual({ id: "10001", name: "测试群" });
        expect(content.channel).toEqual({ id: "10001", type: 0, name: "测试群" });
        expect(content.user).toEqual({ id: "90001", name: "小明" });
        expect(content.member).toEqual({ user: { id: "90001", name: "小明" } });
        expect(content.message?.id).toBe("m1");
        expect(content.message?.content).toBe("你好");
    });

    it("私聊消息 → 无 guild/member，channel DIRECT", async () => {
        const content = await toSatoriMessageEvent(
            makeRawMsg({ chatType: ChatType.C2C, peerUin: "90001" }),
            { selfUin: "10001" },
        );
        expect(content.guild).toBeUndefined();
        expect(content.member).toBeUndefined();
        expect(content.channel).toEqual({ id: "90001", type: 1, name: "小明" });
    });

    it("空元素消息：message.content 不写", async () => {
        const content = await toSatoriMessageEvent(makeRawMsg({ elements: [] }), { selfUin: "1" });
        expect(content.message?.content).toBeUndefined();
    });
});

describe("hasSatoriGrayTip", () => {
    it("REVOKE / GROUP 子类型命中", () => {
        expect(hasSatoriGrayTip(makeRevokeMsg())).toBe(true);
        expect(
            hasSatoriGrayTip(
                makeMemberChangeMsg({ groupElement: { type: TipGroupElementType.MEMBER_ADD } }),
            ),
        ).toBe(true);
    });

    it("其他子类型（JSON 等）与普通元素不命中", () => {
        expect(
            hasSatoriGrayTip(
                makeRawMsg({
                    elements: [
                        {
                            elementType: 8,
                            grayTipElement: { subElementType: GrayTipSubType.JSON },
                        },
                    ],
                }),
            ),
        ).toBe(false);
        expect(hasSatoriGrayTip(makeRawMsg())).toBe(false);
    });

    it("无 grayTipElement 的元素列表 → false", () => {
        expect(hasSatoriGrayTip(makeRawMsg({ elements: [] }))).toBe(false);
    });
});

describe("toSatoriGrayTipEvent：撤回", () => {
    it("群聊撤回 → message-deleted（guild + channel TEXT + operator uid→uin）", async () => {
        const raw = makeRevokeMsg({
            msgTime: "1700000100",
            msgSeq: "9",
        });
        const content = await toSatoriGrayTipEvent(raw, UIN_MAP);
        expect(content).toEqual({
            type: "message-deleted",
            timestamp: 1700000100,
            channel: { id: "10001", type: 0 },
            guild: { id: "10001", name: "测试群" },
            message: { id: "9" }, // NT 侧撤回 id 取 msgSeq（对齐 OB11 语义）
            operator: { id: "80001", name: undefined }, // operatorNick 缺省 → 无 name
        });
    });

    it("私聊撤回 → channel DIRECT、无 guild", async () => {
        const content = await toSatoriGrayTipEvent(
            makeRevokeMsg({ chatType: ChatType.C2C, peerUin: "90001" }),
            UIN_MAP,
        );
        expect(content?.channel).toEqual({ id: "90001", type: 1 });
        expect(content?.guild).toBeUndefined();
    });

    it("operator uid 不在映射表：退化用原 uid", async () => {
        const content = await toSatoriGrayTipEvent(
            makeRevokeMsg(undefined, "unknown-uid"),
            new Map(),
        );
        expect(content?.operator?.id).toBe("unknown-uid");
    });

    it("operatorNick 非空 → operator.name 写入", async () => {
        const raw = makeRawMsg({
            elements: [
                {
                    elementType: 8,
                    grayTipElement: {
                        subElementType: GrayTipSubType.REVOKE,
                        revokeElement: { operatorUid: "op-uid-1", operatorNick: "管理员" },
                    },
                },
            ],
        });
        const content = await toSatoriGrayTipEvent(raw, UIN_MAP);
        expect(content?.operator).toEqual({ id: "80001", name: "管理员" });
    });

    it("peerUin 缺失 → channel.id 空串兜底", async () => {
        const raw = makeRevokeMsg({ peerUin: undefined as unknown as string });
        const content = await toSatoriGrayTipEvent(raw, UIN_MAP);
        expect(content?.channel?.id).toBe("");
    });
});

describe("toSatoriGrayTipEvent：群成员变动", () => {
    it("MEMBER_ADD → guild-member-added（member/user/operator 构造）", async () => {
        const raw = makeMemberChangeMsg(
            {
                groupElement: {
                    type: TipGroupElementType.MEMBER_ADD,
                    memberUid: "member-uid-1",
                    memberNick: "新人",
                    memberRemark: "备注",
                    adminUid: "admin-uid-1",
                    adminNick: "管理员",
                },
            },
            { msgTime: "1700000200" },
        );
        const content = await toSatoriGrayTipEvent(raw, UIN_MAP);
        expect(content).toEqual({
            type: "guild-member-added",
            timestamp: 1700000200,
            guild: { id: "10001", name: "测试群" },
            channel: { id: "10001", type: 0 },
            member: { user: { id: "91001", name: "新人" }, nick: "备注" },
            user: { id: "91001", name: "新人" },
            operator: { id: "92001", name: "管理员" },
        });
    });

    it("QUIT → guild-member-removed", async () => {
        const content = await toSatoriGrayTipEvent(
            makeMemberChangeMsg({
                groupElement: { type: TipGroupElementType.QUIT, memberUid: "member-uid-1" },
            }),
            UIN_MAP,
        );
        expect(content?.type).toBe("guild-member-removed");
    });

    it("adminUid 与 memberUid 相同 / 为空 → 不写 operator", async () => {
        const content = await toSatoriGrayTipEvent(
            makeMemberChangeMsg({
                groupElement: {
                    type: TipGroupElementType.MEMBER_ADD,
                    memberUid: "m",
                    adminUid: "m",
                },
            }),
            new Map(),
        );
        expect(content?.operator).toBeUndefined();
        const empty = await toSatoriGrayTipEvent(
            makeMemberChangeMsg({
                groupElement: {
                    type: TipGroupElementType.MEMBER_ADD,
                    memberUid: "m",
                    adminUid: "",
                },
            }),
            new Map(),
        );
        expect(empty?.operator).toBeUndefined();
    });

    it("memberRemark 为空 / 与 nick 相同 → member.nick 不写", async () => {
        const same = await toSatoriGrayTipEvent(
            makeMemberChangeMsg({
                groupElement: {
                    type: TipGroupElementType.MEMBER_ADD,
                    memberUid: "m",
                    memberNick: "n",
                    memberRemark: "n",
                },
            }),
            new Map(),
        );
        expect(same?.member).toEqual({ user: { id: "m", name: "n" } });
    });

    it("其他 TipGroupElementType（禁言/解散等）→ null（不广播）", async () => {
        const content = await toSatoriGrayTipEvent(
            makeMemberChangeMsg({ groupElement: { type: TipGroupElementType.SHUT_UP } }),
            UIN_MAP,
        );
        expect(content).toBeNull();
    });

    it("type 缺失的 groupElement → null", async () => {
        const content = await toSatoriGrayTipEvent(
            makeMemberChangeMsg({ groupElement: {} }),
            UIN_MAP,
        );
        expect(content).toBeNull();
    });

    it("私聊会话的 GROUP grayTip → 忽略（成员变动仅群聊）", async () => {
        const content = await toSatoriGrayTipEvent(
            makeMemberChangeMsg(
                { groupElement: { type: TipGroupElementType.MEMBER_ADD, memberUid: "m" } },
                { chatType: ChatType.C2C },
            ),
            UIN_MAP,
        );
        expect(content).toBeNull();
    });

    it("groupElement.type 不匹配但前面的 REVOKE 先命中：按元素序翻译", async () => {
        const raw = makeRawMsg({
            elements: [
                {
                    elementType: 8,
                    grayTipElement: {
                        subElementType: GrayTipSubType.GROUP,
                        groupElement: { type: TipGroupElementType.SHUT_UP },
                    },
                },
                {
                    elementType: 8,
                    grayTipElement: {
                        subElementType: GrayTipSubType.REVOKE,
                        revokeElement: { operatorUid: "op-uid-1" },
                    },
                },
            ],
        });
        const content = await toSatoriGrayTipEvent(raw, UIN_MAP);
        expect(content?.type).toBe("message-deleted");
    });
});

describe("toSatoriGrayTipEvent：无匹配", () => {
    it("无 grayTip / 空 uid 映射 → null", async () => {
        expect(await toSatoriGrayTipEvent(makeRawMsg(), new Map())).toBeNull();
        expect(await toSatoriGrayTipEvent(makeRawMsg({ elements: [] }), new Map())).toBeNull();
    });
});

describe("collectSatoriGrayTipUids（re-export 契约）", () => {
    it("撤回 operatorUid 收集（与 core 共享实现一致）", () => {
        expect(collectSatoriGrayTipUids(makeRevokeMsg())).toEqual(["op-uid-1"]);
    });

    it("成员变动 memberUid + adminUid 收集", () => {
        expect(
            collectSatoriGrayTipUids(
                makeMemberChangeMsg({
                    groupElement: { memberUid: "member-uid-1", adminUid: "admin-uid-1" },
                }),
            ),
        ).toEqual(["member-uid-1", "admin-uid-1"]);
    });
});

describe("toSatoriMessageEvent：私聊（guild 缺省分支）", () => {
    it("私聊 message-created：无 guild（pickEventResources 的 guild undefined 路径）", async () => {
        const content = await toSatoriMessageEvent(
            makeRawMsg({ chatType: ChatType.C2C, peerUin: "90001", peerName: "" }),
            { selfUin: "10001" },
        );
        expect(content.guild).toBeUndefined();
        expect(content.member).toBeUndefined();
        expect(content.channel?.type).toBe(1);
    });
});

describe("toSatoriGrayTipEvent：防御分支补漏", () => {
    it("REVOKE 子类型但无 revokeElement → null（不广播）", async () => {
        const raw = makeRawMsg({
            elements: [
                { elementType: 8, grayTipElement: { subElementType: GrayTipSubType.REVOKE } },
            ],
        });
        expect(await toSatoriGrayTipEvent(raw, UIN_MAP)).toBeNull();
    });

    it("groupElement 的 memberUid / adminUid 缺失 → 空串兜底（?? 分支）", async () => {
        const content = await toSatoriGrayTipEvent(
            makeMemberChangeMsg({ groupElement: { type: TipGroupElementType.MEMBER_ADD } }),
            UIN_MAP,
        );
        expect(content?.member?.user?.id).toBe("");
        expect(content?.user?.id).toBe("");
        expect(content?.operator).toBeUndefined();
    });

    it("peerName 为空串 → guild 无 name（toGroupGuild 空串分支）", async () => {
        const content = await toSatoriGrayTipEvent(
            makeMemberChangeMsg(
                { groupElement: { type: TipGroupElementType.MEMBER_ADD, memberUid: "m" } },
                { peerName: "" },
            ),
            UIN_MAP,
        );
        expect(content?.guild).toEqual({ id: "10001" });
    });

    it("memberRemark 与 nick 相同 → member.nick 不写（重复分支合并断言）", async () => {
        const content = await toSatoriGrayTipEvent(
            makeMemberChangeMsg({
                groupElement: {
                    type: TipGroupElementType.MEMBER_ADD,
                    memberUid: "m",
                    memberNick: "n",
                    memberRemark: "",
                },
            }),
            UIN_MAP,
        );
        expect(content?.member).toEqual({ user: { id: "m", name: "n" } });
    });
});
