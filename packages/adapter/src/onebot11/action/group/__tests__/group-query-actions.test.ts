/**
 * 群查询动作测试：get_group_info / get_group_list / get_group_member_list /
 * get_group_member_info / get_group_at_all_remain。
 *
 * 锁定行为：GroupCache 缓存优先（no_cache 直查 kernel）、成员列表 uid→uin 批量
 * 补全、u_blank 空 uin 回退、禁言/头衔/入群时间等可选字段映射、@全体剩余次数。
 */
import { NTGroupMemberRole } from "@napuketto/kernel";
import { describe, expect, it, vi } from "vitest";
import { makeMember, ob11ActionOf, stubConverters } from "../../__tests__/test-support.js";
import { createGroupQueryActions } from "../query.js";

/** GroupDetailInfo 桩（getGroupInfo 返回）。 */
function groupDetail() {
    return { groupCode: "808", groupName: "测试群", memberNum: 3, maxMemberNum: 500 };
}

describe("get_group_info", () => {
    it("缓存命中 → GroupDetailInfo 映射（member_count/max_member_count）", async () => {
        const cache = {
            getGroupDetail: vi.fn(async () => groupDetail()),
        };
        const result = await ob11ActionOf(
            createGroupQueryActions({ groupApi: {}, groupCache: cache } as never),
            "get_group_info",
        ).handle({ group_id: 808 });
        expect(result.status).toBe("ok");
        expect(result.data).toEqual({
            group_id: 808,
            group_name: "测试群",
            member_count: 3,
            max_member_count: 500,
        });
    });

    it("detail 缺 memberNum/maxMemberNum → member_count/max_member_count 省略", async () => {
        const cache = {
            getGroupDetail: vi.fn(async () => ({ groupCode: "808", groupName: "极简群" })),
        };
        const result = await ob11ActionOf(
            createGroupQueryActions({ groupApi: {}, groupCache: cache } as never),
            "get_group_info",
        ).handle({ group_id: 808 });
        expect(result.data).toEqual({ group_id: 808, group_name: "极简群" });
    });

    it("no_cache=true → 直查 groupApi.getGroupInfo，缓存未触", async () => {
        const cache = { getGroupDetail: vi.fn(async () => groupDetail()) };
        const groupApi = { getGroupInfo: vi.fn(async () => groupDetail()) };
        const result = await ob11ActionOf(
            createGroupQueryActions({ groupApi, groupCache: cache } as never),
            "get_group_info",
        ).handle({ group_id: 808, no_cache: true });
        expect(result.status).toBe("ok");
        expect(groupApi.getGroupInfo).toHaveBeenCalledWith("808");
        expect(cache.getGroupDetail).not.toHaveBeenCalled();
    });

    it("未装配缓存 → 直查 groupApi", async () => {
        const groupApi = { getGroupInfo: vi.fn(async () => groupDetail()) };
        const result = await ob11ActionOf(
            createGroupQueryActions({ groupApi } as never),
            "get_group_info",
        ).handle({ group_id: 808 });
        expect(result.status).toBe("ok");
        expect(result.data).toMatchObject({ group_id: 808 });
        expect(groupApi.getGroupInfo).toHaveBeenCalledTimes(1);
    });

    it("缺 group_id → retcode 400（zod 校验）", async () => {
        const result = await ob11ActionOf(
            createGroupQueryActions({ groupApi: {} } as never),
            "get_group_info",
        ).handle({});
        expect(result.retcode).toBe(400);
        expect(result.status).toBe("failed");
    });
});

describe("get_group_list", () => {
    it("缓存装配 → listGroups 全量读并映射 GroupInfo", async () => {
        const groups = [
            { groupCode: "808", groupName: "A 群", memberCount: 10, maxMember: 200 },
            { groupCode: "909", groupName: "B 群" },
        ];
        const cache = { listGroups: vi.fn(() => groups) };
        const result = await ob11ActionOf(
            createGroupQueryActions({ groupApi: {}, groupCache: cache } as never),
            "get_group_list",
        ).handle({});
        expect(result.status).toBe("ok");
        expect(result.data).toEqual([
            { group_id: 808, group_name: "A 群", member_count: 10, max_member_count: 200 },
            { group_id: 909, group_name: "B 群" },
        ]);
        expect(cache.listGroups).toHaveBeenCalledTimes(1);
    });

    it("no_cache=true → listGroupsRefreshed 主动刷新", async () => {
        const cache = {
            listGroups: vi.fn(() => []),
            listGroupsRefreshed: vi.fn(async () => [{ groupCode: "808", groupName: "刷新群" }]),
        };
        const result = await ob11ActionOf(
            createGroupQueryActions({ groupApi: {}, groupCache: cache } as never),
            "get_group_list",
        ).handle({ no_cache: true });
        expect(result.data).toEqual([{ group_id: 808, group_name: "刷新群" }]);
        expect(cache.listGroupsRefreshed).toHaveBeenCalledTimes(1);
        expect(cache.listGroups).not.toHaveBeenCalled();
    });

    it("未装配缓存 → groupApi.getGroupList(true) 兜底", async () => {
        const groupApi = {
            getGroupList: vi.fn(async () => [{ groupCode: "7", groupName: "兜底" }]),
        };
        const result = await ob11ActionOf(
            createGroupQueryActions({ groupApi } as never),
            "get_group_list",
        ).handle({});
        expect(result.data).toEqual([{ group_id: 7, group_name: "兜底" }]);
        expect(groupApi.getGroupList).toHaveBeenCalledWith(true);
    });
});

describe("get_group_member_list", () => {
    it("缓存整表读 → uidToUin 批量补全 uin（空 uin 回退映射值）", async () => {
        const { uidToUin } = stubConverters();
        const members = [
            makeMember({
                uid: "u90001",
                uin: "90001",
                cardName: "名片甲",
                role: NTGroupMemberRole.OWNER,
            }),
            makeMember({ uid: "u90002", uin: "", role: NTGroupMemberRole.ADMIN, shutUpTime: 60 }),
        ];
        const cache = { getMembers: vi.fn(async () => members) };
        const result = await ob11ActionOf(
            createGroupQueryActions({ groupApi: { uidToUin }, groupCache: cache } as never),
            "get_group_member_list",
        ).handle({ group_id: 808 });
        expect(result.status).toBe("ok");
        expect(result.data).toEqual([
            {
                group_id: 808,
                user_id: 90001,
                nickname: "小明",
                role: "owner",
                card: "名片甲",
            },
            {
                group_id: 808,
                user_id: 90002,
                nickname: "小明",
                role: "admin",
                shut_up_timestamp: 60000,
            },
        ]);
        expect(uidToUin).toHaveBeenCalledWith(["u90001", "u90002"]);
    });

    it("no_cache=true → 直查 groupApi.getGroupMemberList(groupCode, true)", async () => {
        const { uidToUin } = stubConverters();
        const groupApi = {
            getGroupMemberList: vi.fn(async () => [makeMember({ uid: "u90009", uin: "90009" })]),
            uidToUin,
        };
        const cache = { getMembers: vi.fn(async () => []) };
        const result = await ob11ActionOf(
            createGroupQueryActions({ groupApi, groupCache: cache } as never),
            "get_group_member_list",
        ).handle({ group_id: 808, no_cache: true });
        expect(result.data).toEqual([
            { group_id: 808, user_id: 90009, nickname: "小明", role: "member" },
        ]);
        expect(groupApi.getGroupMemberList).toHaveBeenCalledWith("808", true);
        expect(cache.getMembers).not.toHaveBeenCalled();
    });

    it("未装配缓存 → 直查 groupApi（no_cache=false）", async () => {
        const { uidToUin } = stubConverters();
        const groupApi = {
            getGroupMemberList: vi.fn(async () => []),
            uidToUin,
        };
        const result = await ob11ActionOf(
            createGroupQueryActions({ groupApi } as never),
            "get_group_member_list",
        ).handle({ group_id: 808 });
        expect(result.data).toEqual([]);
        expect(groupApi.getGroupMemberList).toHaveBeenCalledWith("808", false);
    });
});

describe("get_group_member_info", () => {
    it("缓存命中 → uin 解析 + 成员字段映射", async () => {
        const { uinToUid, uidToUin } = stubConverters();
        const cache = {
            getMember: vi.fn(async () =>
                makeMember({
                    uid: "u90001",
                    uin: "",
                    cardName: "卡名",
                    memberSpecialTitle: "头衔",
                }),
            ),
        };
        const result = await ob11ActionOf(
            createGroupQueryActions({
                groupApi: { uinToUid, uidToUin },
                groupCache: cache,
            } as never),
            "get_group_member_info",
        ).handle({ group_id: 808, user_id: 90001 });
        expect(result.status).toBe("ok");
        expect(result.data).toMatchObject({
            group_id: 808,
            user_id: 90001,
            nickname: "小明",
            card: "卡名",
            title: "头衔",
            special_title: "头衔",
            role: "member",
        });
        expect(uinToUid).toHaveBeenCalledWith(["90001"]);
        expect(cache.getMember).toHaveBeenCalledWith("808", "u90001");
    });

    it("uin 解析失败（不在映射）→ retcode 102 NOT_FOUND", async () => {
        const groupApi = {
            uinToUid: vi.fn(async () => new Map<string, string>()),
        };
        const result = await ob11ActionOf(
            createGroupQueryActions({ groupApi } as never),
            "get_group_member_info",
        ).handle({ group_id: 808, user_id: 11111 });
        expect(result.retcode).toBe(102);
    });

    it("缓存未命中（成员不在群）→ retcode 102", async () => {
        const { uinToUid, uidToUin } = stubConverters();
        const cache = { getMember: vi.fn(async () => undefined) };
        const result = await ob11ActionOf(
            createGroupQueryActions({
                groupApi: { uinToUid, uidToUin },
                groupCache: cache,
            } as never),
            "get_group_member_info",
        ).handle({ group_id: 808, user_id: 90001 });
        expect(result.retcode).toBe(102);
    });

    it("no_cache=true → 直查 getGroupMemberInfo 取首个成员", async () => {
        const { uinToUid, uidToUin } = stubConverters();
        const groupApi = {
            uinToUid,
            uidToUin,
            getGroupMemberInfo: vi.fn(async () => [makeMember({ uid: "u90001", uin: "90001" })]),
        };
        const result = await ob11ActionOf(
            createGroupQueryActions({ groupApi } as never),
            "get_group_member_info",
        ).handle({ group_id: 808, user_id: 90001, no_cache: true });
        expect(result.status).toBe("ok");
        expect(groupApi.getGroupMemberInfo).toHaveBeenCalledWith("808", ["u90001"]);
    });
});

describe("get_group_at_all_remain", () => {
    it("GroupRemainAtTimes → OB11 字段映射", async () => {
        const groupApi = {
            getGroupRemainAtTimes: vi.fn(async () => ({
                canAtAll: true,
                remainAtAllCountForUin: 4,
                remainAtAllCountForGroup: 10,
                atTimesMsg: "",
                canNotAtAllMsg: "",
            })),
        };
        const result = await ob11ActionOf(
            createGroupQueryActions({ groupApi } as never),
            "get_group_at_all_remain",
        ).handle({ group_id: 808 });
        expect(result.data).toEqual({
            can_at_all: true,
            remain_at_all_count_for_uin: 4,
            remain_at_all_count_for_group: 10,
        });
    });

    it("缺 group_id → retcode 400", async () => {
        const result = await ob11ActionOf(
            createGroupQueryActions({ groupApi: {} } as never),
            "get_group_at_all_remain",
        ).handle({});
        expect(result.retcode).toBe(400);
    });
});
