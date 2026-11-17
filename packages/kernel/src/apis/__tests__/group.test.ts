/**
 * group.ts extractGroupDetail 基线测试（fallow 重构目标，untested risk）
 *
 * 覆盖 getGroupDetailInfo 返回形状提取：
 *  - result 为完整详情对象 → 直接返回
 *  - result 非对象 → 从 raw.groupInfo / detailInfo / info 提取
 *  - 残缺形状（缺 groupName/memberNum/maxMemberNum）/ 数组 / 空对象 / 全无 → null
 */
import { describe, expect, it } from "vitest";
import type { GroupDetailInfo } from "../../types/index.js";
import { extractGroupDetail } from "../group.js";

/** 最小合法群详情（四要素：groupCode / groupName / memberNum / maxMemberNum）。 */
function detailOf(groupCode: string): GroupDetailInfo {
    return {
        groupCode,
        groupUin: "1",
        ownerUin: "1",
        groupName: `群${groupCode}`,
        memberNum: 1,
        maxMemberNum: 200,
    };
}

describe("extractGroupDetail", () => {
    it("result 为完整详情对象直接返回（同一引用）", () => {
        const detail = detailOf("123");
        expect(extractGroupDetail(detail, { result: 0 })).toBe(detail);
    });

    it("result 为 0 时从 raw.groupInfo 提取", () => {
        const info = detailOf("1");
        expect(extractGroupDetail(0, { groupInfo: info })).toBe(info);
    });

    it("result 为 0 时从 raw.detailInfo 提取", () => {
        const info = detailOf("2");
        expect(extractGroupDetail(0, { detailInfo: info })).toBe(info);
    });

    it("result 为 0 时从 raw.info 提取", () => {
        const info = detailOf("3");
        expect(extractGroupDetail(0, { info })).toBe(info);
    });

    it("result 为 0 且候选为 null → null", () => {
        expect(extractGroupDetail(0, { groupInfo: null })).toBeNull();
    });

    it("result 为 null 且无候选 → null", () => {
        expect(extractGroupDetail(null, {})).toBeNull();
    });

    it("result 非对象非 0（如字符串）且无候选 → null", () => {
        expect(extractGroupDetail("abc", {})).toBeNull();
    });

    it("残缺详情（缺必填字段）/ 数组 / 空对象 → null（不再强转垃圾数据）", () => {
        expect(extractGroupDetail({ groupCode: "x" }, {})).toBeNull();
        expect(extractGroupDetail([detailOf("4")], {})).toBeNull();
        expect(extractGroupDetail({}, {})).toBeNull();
        expect(extractGroupDetail(0, { groupInfo: { groupCode: "x", groupName: "g" } })).toBeNull();
    });
});
