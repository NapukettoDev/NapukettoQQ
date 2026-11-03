/**
 * translate.ts 基线测试（onebot11 翻译层，fallow CRITICAL #11）
 *
 * 锁定 NT 实体 → OB11 结构的薄映射行为：
 *  - toOb11GroupInfo / toOb11GroupInfoDetail：可选字段数字类型才写入
 *  - toOb11GroupMemberInfo：uin 补全（uin 空→uidToUin→uid）、
 *    card/title/禁言/入群/发言/年龄等可选字段的写入条件
 */
import {
    type Group,
    type GroupDetailInfo,
    type GroupMember,
    NTGroupMemberRole,
} from "@napuketto/kernel";
import { describe, expect, it } from "vitest";
import { toOb11GroupInfo, toOb11GroupInfoDetail, toOb11GroupMemberInfo } from "../translate.js";

/** 构造群成员（缺省最小合法值，overrides 覆盖）。 */
function makeMember(overrides: Partial<GroupMember> = {}): GroupMember {
    return {
        uid: "u1",
        uin: "10001",
        nick: "昵称",
        cardName: "",
        remark: "",
        role: NTGroupMemberRole.MEMBER,
        shutUpTime: 0,
        joinTime: "",
        lastSpeakTime: "",
        ...overrides,
    };
}

describe("toOb11GroupInfo", () => {
    const group: Group = {
        groupCode: "10001",
        groupName: "测试群",
        memberCount: 10,
        maxMember: 500,
    };

    it("必填字段映射 + 数字可选字段写入", () => {
        expect(toOb11GroupInfo(group)).toEqual({
            group_id: 10001,
            group_name: "测试群",
            member_count: 10,
            max_member_count: 500,
        });
    });

    it("memberCount / maxMember 缺失 → 不写入", () => {
        expect(toOb11GroupInfo({ groupCode: "10001", groupName: "群" } as Group)).toEqual({
            group_id: 10001,
            group_name: "群",
        });
    });
});

describe("toOb11GroupInfoDetail", () => {
    const detail: GroupDetailInfo = {
        groupCode: "10001",
        groupUin: "10001",
        ownerUin: "1",
        groupName: "测试群",
        memberNum: 10,
        maxMemberNum: 500,
    };

    it("memberNum / maxMemberNum 写入", () => {
        expect(toOb11GroupInfoDetail(detail)).toEqual({
            group_id: 10001,
            group_name: "测试群",
            member_count: 10,
            max_member_count: 500,
        });
    });
});

describe("toOb11GroupMemberInfo", () => {
    it("uin 非空 → 直接用；role=member", () => {
        const member = makeMember({ uin: "10001" });
        expect(toOb11GroupMemberInfo("20001", member, new Map())).toEqual({
            group_id: 20001,
            user_id: 10001,
            nickname: "昵称",
            role: "member",
        });
    });

    it("uin 空 → uidToUin 映射补全", () => {
        const member = makeMember({ uin: "" });
        const map = new Map([["u1", "90001"]]);
        expect(toOb11GroupMemberInfo("20001", member, map).user_id).toBe(90001);
    });

    it("uin 空且映射缺失 → 回退 uid", () => {
        const member = makeMember({ uin: "" });
        expect(toOb11GroupMemberInfo("20001", member, new Map()).user_id).toBe(Number("u1"));
    });

    it("role 映射：OWNER=owner、ADMIN=admin、其余=member", () => {
        expect(
            toOb11GroupMemberInfo("g", makeMember({ role: NTGroupMemberRole.OWNER }), new Map())
                .role,
        ).toBe("owner");
        expect(
            toOb11GroupMemberInfo("g", makeMember({ role: NTGroupMemberRole.ADMIN }), new Map())
                .role,
        ).toBe("admin");
        expect(
            toOb11GroupMemberInfo(
                "g",
                makeMember({ role: NTGroupMemberRole.UNSPECIFIED }),
                new Map(),
            ).role,
        ).toBe("member");
    });

    it("cardName 非空 → card", () => {
        const member = makeMember({ cardName: "马甲" });
        expect(toOb11GroupMemberInfo("g", member, new Map()).card).toBe("马甲");
    });

    it("memberSpecialTitle 非空 → title + special_title 双写", () => {
        const member = makeMember({ memberSpecialTitle: "管理员" });
        const info = toOb11GroupMemberInfo("g", member, new Map());
        expect(info.title).toBe("管理员");
        expect(info.special_title).toBe("管理员");
    });

    it("shutUpTime > 0 → shut_up_timestamp（秒×1000）", () => {
        const member = makeMember({ shutUpTime: 30 });
        expect(toOb11GroupMemberInfo("g", member, new Map()).shut_up_timestamp).toBe(30000);
    });

    it("joinTime / lastSpeakTime 非空非 '0' → 数字写入", () => {
        const member = makeMember({ joinTime: "1600000000", lastSpeakTime: "1700000000" });
        const info = toOb11GroupMemberInfo("g", member, new Map());
        expect(info.join_time).toBe(1600000000);
        expect(info.last_sent_time).toBe(1700000000);
    });

    it("joinTime = '0' → 不写入", () => {
        const member = makeMember({ joinTime: "0" });
        expect(toOb11GroupMemberInfo("g", member, new Map()).join_time).toBeUndefined();
    });

    it("age 为数字 → 写入", () => {
        const member = makeMember({ age: 25 });
        expect(toOb11GroupMemberInfo("g", member, new Map()).age).toBe(25);
    });
});
