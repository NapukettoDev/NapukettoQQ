/**
 * Milky 实体翻译测试（helper/message/entities.ts，纯函数）
 *
 * 锁定：toGroupEntity（完整详情 / undefined 兜底）、groupListToEntity、
 * toGroupMemberEntity（成员在/缺、禁言秒数正负、role 缺省 member、uin 兜底
 * 优先级）、toFriendEntity（friend 在/缺）。
 */

import type { GroupDetailInfo, GroupMember } from "@napuketto/kernel";
import { describe, expect, it } from "vitest";
import {
    groupListToEntity,
    toFriendEntity,
    toGroupEntity,
    toGroupMemberEntity,
} from "../entities.js";

describe("toGroupEntity", () => {
    it("详情齐全 → 字段逐一映射", () => {
        const detail: GroupDetailInfo = {
            groupCode: "10001",
            groupUin: "10001",
            ownerUin: "20002",
            groupName: "测试群",
            memberNum: 3,
            maxMemberNum: 500,
            remarkName: "备注",
            groupCreateTime: 1760000000,
        };
        expect(toGroupEntity(detail, "10001")).toEqual({
            group_id: 10001,
            group_name: "测试群",
            member_count: 3,
            max_member_count: 500,
            remark: "备注",
            created_time: 1760000000,
            description: "",
            question: "",
            announcement: "",
        });
    });

    it("detail 缺失 → 最小实体（group_id 仍取入参群号）", () => {
        expect(toGroupEntity(undefined, "10001")).toEqual({
            group_id: 10001,
            group_name: "",
            member_count: 0,
            max_member_count: 0,
            remark: "",
            created_time: 0,
            description: "",
            question: "",
            announcement: "",
        });
    });
});

describe("groupListToEntity", () => {
    it("列表项 → 实体（memberCount/maxMember 直取）", () => {
        expect(
            groupListToEntity({
                groupCode: "10002",
                groupName: "列表群",
                memberCount: 9,
                maxMember: 100,
            }),
        ).toEqual({
            group_id: 10002,
            group_name: "列表群",
            member_count: 9,
            max_member_count: 100,
            remark: "",
            created_time: 0,
            description: "",
            question: "",
            announcement: "",
        });
    });
});

describe("toGroupMemberEntity", () => {
    it("成员齐全 → 字段映射（禁言中 → shut_up_end_time 未来秒）", () => {
        const now = Math.floor(Date.now() / 1000);
        const member: GroupMember = {
            uid: "uid-20002",
            uin: "20002",
            nick: "甲",
            cardName: "名片",
            remark: "",
            role: 3,
            shutUpTime: 600,
            joinTime: "1760000000",
            lastSpeakTime: "1760000100",
            memberSpecialTitle: "头衔",
        };
        const entity = toGroupMemberEntity(member, "10001", "20002");
        expect(entity).toMatchObject({
            user_id: 20002,
            nickname: "甲",
            sex: "unknown",
            group_id: 10001,
            card: "名片",
            title: "头衔",
            level: 0,
            role: "admin",
            join_time: 1760000000,
            last_sent_time: 1760000100,
        });
        expect(entity.shut_up_end_time).toBeGreaterThanOrEqual(now + 600);
    });

    it("member 缺失 → 按 uin 兜底最小实体（role member / 无禁言）", () => {
        expect(toGroupMemberEntity(undefined, "10001", "30003")).toEqual({
            user_id: 30003,
            nickname: "",
            sex: "unknown",
            group_id: 10001,
            card: "",
            title: "",
            level: 0,
            role: "member",
            join_time: 0,
            last_sent_time: 0,
            shut_up_end_time: null,
        });
    });

    it("member.uin 空串 → 入参 uin 兜底；shutUpTime 0 → 无禁言", () => {
        const member: GroupMember = {
            uid: "uid-x",
            uin: "",
            nick: "n",
            cardName: "",
            remark: "",
            role: 1,
            shutUpTime: 0,
            joinTime: "0",
            lastSpeakTime: "0",
        };
        const entity = toGroupMemberEntity(member, "10001", "30003");
        expect(entity.user_id).toBe(30003);
        expect(entity.shut_up_end_time).toBeNull();
    });
});

describe("toFriendEntity", () => {
    it("friend 齐全 → 映射（category 无源兜底）", () => {
        expect(
            toFriendEntity(
                { uid: "uid-20002", uin: "20002", nickname: "甲", remark: "备注" },
                "20002",
                "甲",
            ),
        ).toEqual({
            user_id: 20002,
            nickname: "甲",
            sex: "unknown",
            qid: "",
            remark: "备注",
            category: { category_id: 0, category_name: "" },
        });
    });

    it("friend 缺失 → 按 uin/nick 入参兜底", () => {
        expect(toFriendEntity(undefined, "30003", "乙")).toEqual({
            user_id: 30003,
            nickname: "乙",
            sex: "unknown",
            qid: "",
            remark: "",
            category: { category_id: 0, category_name: "" },
        });
    });

    it("friend.uin 空串 → 入参 uin 兜底；缺 remark 空串", () => {
        const entity = toFriendEntity(
            { uid: "u", uin: "", nickname: "n", remark: "" },
            "40004",
            "丙",
        );
        expect(entity.user_id).toBe(40004);
        expect(entity.remark).toBe("");
    });
});
