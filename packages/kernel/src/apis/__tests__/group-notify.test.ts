/**
 * group-notify.ts extract 系列基线测试（列表提取纯函数，fallow 0% 覆盖）
 *
 * 锁定 extractNotifyList / extractMemberList 的宽容形状兼容：
 *  - 直接数组 / notifies 字段 / groupNotifies 字段 / memberList / list
 *  - 非数组 / 非对象 / 缺字段 → 空数组
 */
import { describe, expect, it } from "vitest";
import { extractMemberList, extractNotifyList } from "../group-notify.js";

describe("extractNotifyList", () => {
    it("直接数组 → 原样返回", () => {
        const arr = [{ seq: "1", type: 1 }];
        expect(extractNotifyList(arr)).toEqual(arr);
    });

    it("notifies 字段 → 返回该字段", () => {
        const notifies = [{ seq: "1", type: 1 }];
        expect(extractNotifyList({ notifies })).toEqual(notifies);
    });

    it("groupNotifies 字段 → 返回该字段", () => {
        const groupNotifies = [{ seq: "2", type: 2 }];
        expect(extractNotifyList({ groupNotifies })).toEqual(groupNotifies);
    });

    it("非数组 / 非对象 / 缺字段 → 空数组", () => {
        expect(extractNotifyList(null)).toEqual([]);
        expect(extractNotifyList(undefined)).toEqual([]);
        expect(extractNotifyList("str")).toEqual([]);
        expect(extractNotifyList(42)).toEqual([]);
        expect(extractNotifyList({ other: 1 })).toEqual([]);
        expect(extractNotifyList({ notifies: "not-array" })).toEqual([]);
    });
});

describe("extractMemberList", () => {
    it("直接数组 → 逐项校验后返回", () => {
        const arr = [{ uid: "u1", uin: "10001" }];
        expect(extractMemberList(arr)).toEqual(arr);
    });

    it("memberList 字段 → 返回该字段", () => {
        const memberList = [{ uid: "u1", uin: "10001", nick: "A" }];
        expect(extractMemberList({ memberList })).toEqual(memberList);
    });

    it("list 字段 → 返回该字段", () => {
        const list = [{ uid: "u2", uin: "10002", nick: "B" }];
        expect(extractMemberList({ list })).toEqual(list);
    });

    it("infos Map → 逐项校验后返回", () => {
        const infos = new Map([["u3", { uid: "u3", uin: "10003" }]]);
        expect(extractMemberList({ infos })).toEqual([{ uid: "u3", uin: "10003" }]);
    });

    it("残缺成员项（缺 uin）被逐项丢弃", () => {
        expect(extractMemberList([{ uid: "u1" }, { uid: "u2", uin: "10002" }])).toEqual([
            { uid: "u2", uin: "10002" },
        ]);
    });

    it("非数组 / 非对象 / 缺字段 → 空数组", () => {
        expect(extractMemberList(null)).toEqual([]);
        expect(extractMemberList(undefined)).toEqual([]);
        expect(extractMemberList("str")).toEqual([]);
        expect(extractMemberList(42)).toEqual([]);
        expect(extractMemberList({ other: 1 })).toEqual([]);
        expect(extractMemberList({ memberList: "not-array" })).toEqual([]);
    });
});
