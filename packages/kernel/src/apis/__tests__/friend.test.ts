/**
 * friend.ts toDoubtFriendRequestInfo 基线测试（fallow 重构目标，untested risk）
 *
 * 覆盖可疑好友申请转换：
 *  - flag/type 必填；uin 仅在能解析为正整数时出现（绝不产出 NaN）
 *  - 可选字段条件赋值（exactOptionalPropertyTypes）
 *  - uid→uin 转换缺失时省略 uin
 */
import { describe, expect, it } from "vitest";
import { toDoubtFriendRequestInfo } from "../friend.js";

describe("toDoubtFriendRequestInfo", () => {
    it("uinMap 无命中时数字形态的 UID 仍只用作 flag", () => {
        const item = { uid: "10001" } as never;
        expect(toDoubtFriendRequestInfo(item, new Map())).toEqual({
            flag: "10001",
            type: "doubt",
        });
    });

    it("uid 形如 u_xxx 且 uinMap 未命中 → 不产出 NaN，uin 字段缺省", () => {
        const item = { uid: "u_a1b2c3" } as never;
        const result = toDoubtFriendRequestInfo(item, new Map());
        expect(result).toEqual({ flag: "u_a1b2c3", type: "doubt" });
        expect("uin" in result).toBe(false);
        // JSON 序列化后不得出现 null（NaN 的序列化产物）
        expect(JSON.stringify(result)).not.toContain("null");
    });

    it("uinMap 命中时 uin 用转换值", () => {
        const item = { uid: "u1" } as never;
        expect(toDoubtFriendRequestInfo(item, new Map([["u1", "10001"]]))).toMatchObject({
            flag: "u1",
            uin: 10001,
            type: "doubt",
        });
    });

    it("全部可选字段填充", () => {
        const item = {
            uid: "u1",
            nick: "小明",
            source: "好友推荐",
            reason: "认识一下",
            msg: "你好",
            groupCode: "g1",
            reqTime: "123456",
        } as never;
        expect(toDoubtFriendRequestInfo(item, new Map([["u1", "10001"]]))).toEqual({
            flag: "u1",
            uin: 10001,
            nick: "小明",
            source: "好友推荐",
            reason: "认识一下",
            msg: "你好",
            group_code: "g1",
            time: "123456",
            type: "doubt",
        });
    });

    it("可选字段缺失不出现键（exactOptionalPropertyTypes）", () => {
        const item = { uid: "u1" } as never;
        const result = toDoubtFriendRequestInfo(item, new Map());
        expect("uin" in result).toBe(false);
        expect("nick" in result).toBe(false);
        expect("source" in result).toBe(false);
        expect("reason" in result).toBe(false);
        expect("msg" in result).toBe(false);
        expect("group_code" in result).toBe(false);
        expect("time" in result).toBe(false);
    });
});
