/**
 * gray-tip.ts 基线测试（fallow CRITICAL #3，untested risk）
 *
 * 锁定 collectGrayTipUids 的 uid 收集规则：
 *  - 只收 grayTipElement 内非空的 uid 字段（revoke/group/shutUp 四类）
 *  - 空字符串 / undefined 一律跳过
 *  - 结果去重、顺序按出现次序
 */
import { ChatType, type RawMessage } from "@napuketto/kernel";
import { describe, expect, it } from "vitest";
import { collectGrayTipUids } from "../shared/gray-tip.js";

/** 构造含指定元素的 RawMessage（其余字段取最小合法值）。 */
function makeMsg(elements: RawMessage["elements"]): RawMessage {
    return {
        msgId: "1",
        msgSeq: "1",
        msgTime: "0",
        msgType: 0,
        chatType: ChatType.GROUP,
        peerUid: "g1",
        peerUin: "10001",
        senderUid: "u1",
        senderUin: "1",
        peerName: "群",
        sendNickName: "",
        elements,
    };
}

/** 构造一个灰色提示元素（elementType=8，grayTip 载体）。 */
function grayTip(
    partial: NonNullable<RawMessage["elements"]>[number]["grayTipElement"],
): RawMessage {
    return makeMsg([{ elementType: 8, grayTipElement: partial ?? {} }]);
}

describe("collectGrayTipUids", () => {
    it("空消息 → 空列表", () => {
        expect(collectGrayTipUids(makeMsg([]))).toEqual([]);
    });

    it("无 grayTipElement 的元素 → 空列表", () => {
        expect(
            collectGrayTipUids(makeMsg([{ elementType: 1, textElement: { content: "hi" } }])),
        ).toEqual([]);
    });

    it("grayTipElement 为空对象 → 空列表", () => {
        expect(collectGrayTipUids(grayTip({}))).toEqual([]);
    });

    it("revokeElement.operatorUid 非空 → 收集", () => {
        expect(collectGrayTipUids(grayTip({ revokeElement: { operatorUid: "u_op" } }))).toEqual([
            "u_op",
        ]);
    });

    it("revokeElement.operatorUid 为空字符串 → 跳过", () => {
        expect(collectGrayTipUids(grayTip({ revokeElement: { operatorUid: "" } }))).toEqual([]);
    });

    it("groupElement.memberUid / adminUid → 收集", () => {
        expect(
            collectGrayTipUids(grayTip({ groupElement: { memberUid: "u_m", adminUid: "u_a" } })),
        ).toEqual(["u_m", "u_a"]);
    });

    it("groupElement.shutUp.admin.uid / member.uid → 收集", () => {
        expect(
            collectGrayTipUids(
                grayTip({
                    groupElement: {
                        shutUp: { admin: { uid: "u_admin" }, member: { uid: "u_member" } },
                    },
                }),
            ),
        ).toEqual(["u_admin", "u_member"]);
    });

    it("shutUp 字段缺失（undefined）→ 不抛、跳过", () => {
        expect(collectGrayTipUids(grayTip({ groupElement: {} }))).toEqual([]);
    });

    it("groupElement 为空对象 → 空列表", () => {
        expect(collectGrayTipUids(grayTip({ groupElement: {} }))).toEqual([]);
    });

    it("重复 uid 去重（同一 uid 出现在多处只收一次）", () => {
        expect(
            collectGrayTipUids(
                grayTip({
                    revokeElement: { operatorUid: "u_x" },
                    groupElement: { memberUid: "u_x", shutUp: { member: { uid: "u_x" } } },
                }),
            ),
        ).toEqual(["u_x"]);
    });

    it("混合消息：多元素、部分无 grayTip → 按出现次序收集", () => {
        const msg = makeMsg([
            { elementType: 1, textElement: { content: "普通文本" } },
            { elementType: 8, grayTipElement: { revokeElement: { operatorUid: "u_1" } } },
            { elementType: 8, grayTipElement: { groupElement: { memberUid: "u_2" } } },
            { elementType: 8, grayTipElement: { revokeElement: { operatorUid: "" } } },
        ]);
        expect(collectGrayTipUids(msg)).toEqual(["u_1", "u_2"]);
    });
});
