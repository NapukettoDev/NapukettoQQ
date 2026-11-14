/**
 * satori/action/guild.test.ts：guild.get / list / approve 与成员四动作单测。
 *
 * 锁定参数映射与返回值映射：
 *  - guild.get → getGroupInfo（groupCode/groupName → Guild）
 *  - guild.list → 缓存优先（listGroupsRefreshed），无缓存直查原生
 *  - guild.approve / guild.member.approve → 按 seq 查通知 → handleGroupRequest
 *    （KAGREE / KREFUSE + comment 兜底空串）
 *  - guild.member.get → uinToUid → 缓存命中 / 直查原生 / 不存在抛错
 *  - guild.member.list → 缓存优先 + uidToUin 批量 + 100 条截断 next 令牌
 *  - guild.member.kick → uinToUid + permanent 透传
 *  - guild.member.mute → 毫秒 → 秒（见 guild-mute.test.ts，此处不重复）
 *  - zod 校验失败 → SatoriActionError(400)
 */

import type { GroupMember } from "@napuketto/kernel";
import { type GroupNotify, NTGroupRequestOperateTypes } from "@napuketto/kernel";
import { describe, expect, it, vi } from "vitest";
import { stub } from "../../../core/__tests__/stub.js";
import { SatoriActionError } from "../base-action.js";
import type { GuildActionDeps } from "../guild.js";
import {
    GuildApproveAction,
    GuildGetAction,
    GuildListAction,
    GuildMemberApproveAction,
    GuildMemberGetAction,
    GuildMemberKickAction,
    GuildMemberListAction,
} from "../guild.js";

import { type StubSatoriApi, stubSatoriApi } from "./test-support.js";

/** 构造群成员（最小合法）。 */
function makeMember(uid: string, uin: string, nick: string, cardName = ""): GroupMember {
    return {
        uid,
        uin,
        nick,
        cardName,
        remark: "",
        role: 2,
        shutUpTime: 0,
        joinTime: "0",
        lastSpeakTime: "0",
    };
}

/** 从桩 api 构造 GuildActionDeps（可注入缓存）。 */
function makeDeps(api: StubSatoriApi, groupCache?: Record<string, never>): GuildActionDeps {
    return stub<GuildActionDeps>({
        groupApi: api.groupApi,
        groupNotifyApi: api.groupNotifyApi,
        uinToUid: api.uinToUid,
        uidToUin: api.uidToUin,
        ...(groupCache !== undefined ? { groupCache: groupCache as never } : {}),
    });
}

describe("GuildGetAction", () => {
    it("guild_id → getGroupInfo，返回 Guild（id/groupName）", async () => {
        const api = stubSatoriApi();
        const action = new GuildGetAction(makeDeps(api));
        await expect(action.run({ guild_id: "10001" })).resolves.toEqual({
            id: "10001",
            name: "测试群",
        });
        expect(api.groupApi.getGroupInfo).toHaveBeenCalledWith("10001");
    });

    it("缺 guild_id → SatoriActionError(400)", async () => {
        const action = new GuildGetAction(makeDeps(stubSatoriApi()));
        await expect(action.run({})).rejects.toMatchObject({
            status: 400,
            message: "参数校验失败",
        });
    });
});

describe("GuildListAction", () => {
    it("无缓存：getGroupList(true) → List<Guild>", async () => {
        const api = stubSatoriApi();
        vi.mocked(api.groupApi.getGroupList).mockResolvedValueOnce([
            { groupCode: "10001", groupName: "A" },
            { groupCode: "10002", groupName: "B" },
        ] as never);
        const action = new GuildListAction(makeDeps(api));
        await expect(action.run({})).resolves.toEqual({
            data: [
                { id: "10001", name: "A" },
                { id: "10002", name: "B" },
            ],
        });
        expect(api.groupApi.getGroupList).toHaveBeenCalledWith(true);
    });

    it("有缓存：走 listGroupsRefreshed，不直查原生", async () => {
        const api = stubSatoriApi();
        const groupCache = {
            listGroupsRefreshed: vi.fn(async () => [{ groupCode: "20001", groupName: "C" }]),
        };
        const action = new GuildListAction(makeDeps(api, groupCache as never));
        await expect(action.run({})).resolves.toEqual({ data: [{ id: "20001", name: "C" }] });
        expect(api.groupApi.getGroupList).not.toHaveBeenCalled();
    });
});

describe("GuildApproveAction / GuildMemberApproveAction（共用基类实现）", () => {
    it.each([
        { name: "guild.approve", cls: GuildApproveAction },
        { name: "guild.member.approve", cls: GuildMemberApproveAction },
    ] as const)("approve=true → KAGREE（$name）", async ({ cls }) => {
        const api = stubSatoriApi();
        const notify: GroupNotify = { seq: "9527", type: 7, status: 1 };
        vi.mocked(api.groupNotifyApi.getSingleScreenNotifies).mockResolvedValueOnce([
            notify,
        ] as never);
        const action = new cls(makeDeps(api));
        await action.run({ message_id: "9527", approve: true });
        expect(api.groupNotifyApi.getSingleScreenNotifies).toHaveBeenCalledWith(false, 50);
        expect(api.groupNotifyApi.handleGroupRequest).toHaveBeenCalledWith(
            false,
            notify,
            NTGroupRequestOperateTypes.KAGREE,
            "",
        );
    });

    it("approve=false → KREFUSE；comment 透传", async () => {
        const api = stubSatoriApi();
        const notify: GroupNotify = { seq: "42", type: 7, status: 1 };
        vi.mocked(api.groupNotifyApi.getSingleScreenNotifies).mockResolvedValueOnce([
            notify,
        ] as never);
        const action = new GuildApproveAction(makeDeps(api));
        await action.run({ message_id: "42", approve: false, comment: "不通过" });
        expect(api.groupNotifyApi.handleGroupRequest).toHaveBeenCalledWith(
            false,
            notify,
            NTGroupRequestOperateTypes.KREFUSE,
            "不通过",
        );
    });

    it("seq 未匹配任何通知：抛普通 Error（run 包装为 500）", async () => {
        const api = stubSatoriApi();
        const action = new GuildApproveAction(makeDeps(api));
        await expect(action.run({ message_id: "missing", approve: true })).rejects.toMatchObject({
            status: 500,
            message: "群通知不存在",
        });
    });
});

describe("GuildMemberGetAction", () => {
    it("缓存命中：直接映射（cardName 优先作 nick）", async () => {
        const api = stubSatoriApi();
        const groupCache = {
            getMember: vi.fn(async () => makeMember("uid_123", "123", "原昵", "名片")),
        };
        const action = new GuildMemberGetAction(makeDeps(api, groupCache as never));
        await expect(action.run({ guild_id: "10001", user_id: "123" })).resolves.toEqual({
            user: { id: "123", name: "原昵" },
            nick: "名片",
        });
        expect(api.uinToUid).toHaveBeenCalledWith(["123"]);
        expect(api.groupApi.getGroupMemberInfo).not.toHaveBeenCalled();
    });

    it("缓存未命中：getGroupMemberInfo 整群拉取后单查", async () => {
        const api = stubSatoriApi();
        vi.mocked(api.groupApi.getGroupMemberInfo).mockResolvedValueOnce([
            makeMember("uid_123", "999", "直查"),
        ] as never);
        const action = new GuildMemberGetAction(makeDeps(api));
        await expect(action.run({ guild_id: "10001", user_id: "123" })).resolves.toEqual({
            user: { id: "123", name: "直查" },
        });
        expect(api.groupApi.getGroupMemberInfo).toHaveBeenCalledWith("10001", ["uid_123"]);
    });

    it("直查也没有该成员：抛「群成员不存在」（500）", async () => {
        const api = stubSatoriApi();
        vi.mocked(api.groupApi.getGroupMemberInfo).mockResolvedValueOnce([
            makeMember("uid_other", "888", "别人"),
        ] as never);
        const action = new GuildMemberGetAction(makeDeps(api));
        await expect(action.run({ guild_id: "10001", user_id: "123" })).rejects.toMatchObject({
            status: 500,
            message: "群成员不存在",
        });
    });

    it("cardName 为空 → 不写 nick；cardName 等于 nick → 不重复写", async () => {
        const api = stubSatoriApi();
        const groupCache = {
            getMember: vi.fn(async () => makeMember("uid_123", "123", "昵称", "")),
        };
        const action = new GuildMemberGetAction(makeDeps(api, groupCache as never));
        await expect(action.run({ guild_id: "10001", user_id: "123" })).resolves.toEqual({
            user: { id: "123", name: "昵称" },
        });
        const same = {
            getMember: vi.fn(async () => makeMember("uid_123", "123", "同名", "同名")),
        };
        const action2 = new GuildMemberGetAction(makeDeps(api, same as never));
        await expect(action2.run({ guild_id: "10001", user_id: "123" })).resolves.toEqual({
            user: { id: "123", name: "同名" },
        });
    });
});

describe("GuildMemberListAction", () => {
    it("缓存命中：批量 uidToUin（user.id = uin），无 next（≤100）", async () => {
        const api = stubSatoriApi();
        api.uidToUin.mockResolvedValueOnce(
            new Map([
                ["uid_a", "101"],
                ["uid_b", "102"],
            ]),
        );
        const groupCache = {
            getMembers: vi.fn(async () => [
                makeMember("uid_a", "1", "A"),
                makeMember("uid_b", "2", "B"),
            ]),
        };
        const action = new GuildMemberListAction(makeDeps(api, groupCache as never));
        await expect(action.run({ guild_id: "10001" })).resolves.toEqual({
            data: [{ user: { id: "101", name: "A" } }, { user: { id: "102", name: "B" } }],
        });
        expect(api.groupApi.getGroupMemberList).not.toHaveBeenCalled();
    });

    it("缓存空/缺失：getGroupMemberList 直查；uidToUin 未命中回退成员 uin", async () => {
        const api = stubSatoriApi();
        vi.mocked(api.groupApi.getGroupMemberList).mockResolvedValueOnce([
            makeMember("uid_a", "101", "A"),
        ] as never);
        api.uidToUin.mockResolvedValueOnce(new Map());
        const action = new GuildMemberListAction(makeDeps(api));
        const result = await action.run({ guild_id: "10001", next: undefined });
        expect(result.data).toEqual([{ user: { id: "101", name: "A" } }]);
        expect(api.groupApi.getGroupMemberList).toHaveBeenCalledWith("10001", true);
    });

    it("超过 100 条：截断到 100 且 next 指示分页", async () => {
        const api = stubSatoriApi();
        const many: GroupMember[] = [];
        for (let i = 0; i < 150; i += 1) {
            many.push(makeMember(`uid_${i}`, String(i), `成员${i}`));
        }
        const groupCache = { getMembers: vi.fn(async () => many) };
        api.uidToUin.mockResolvedValueOnce(new Map());
        const action = new GuildMemberListAction(makeDeps(api, groupCache as never));
        const result = await action.run({ guild_id: "10001" });
        expect(result.data).toHaveLength(100);
        expect(result.next).toBe("100");
    });

    it("正好 100 条：不写 next", async () => {
        const api = stubSatoriApi();
        const many: GroupMember[] = [];
        for (let i = 0; i < 100; i += 1) {
            many.push(makeMember(`uid_${i}`, String(i), `成员${i}`));
        }
        const groupCache = { getMembers: vi.fn(async () => many) };
        api.uidToUin.mockResolvedValueOnce(new Map());
        const action = new GuildMemberListAction(makeDeps(api, groupCache as never));
        const result = await action.run({ guild_id: "10001" });
        expect(result.data).toHaveLength(100);
        expect(result.next).toBeUndefined();
    });
});

describe("GuildMemberKickAction", () => {
    it("uinToUid → kickMember（permanent 缺省 false）", async () => {
        const api = stubSatoriApi();
        const action = new GuildMemberKickAction(makeDeps(api));
        await action.run({ guild_id: "10001", user_id: "123" });
        expect(api.groupApi.kickMember).toHaveBeenCalledWith("10001", ["uid_123"], false);
    });

    it("permanent=true 透传", async () => {
        const api = stubSatoriApi();
        const action = new GuildMemberKickAction(makeDeps(api));
        await action.run({ guild_id: "10001", user_id: "123", permanent: true });
        expect(api.groupApi.kickMember).toHaveBeenCalledWith("10001", ["uid_123"], true);
    });
});

describe("校验兜底", () => {
    it("guild_id 非字符串 → SatoriActionError(400)", async () => {
        const action = new GuildMemberKickAction(makeDeps(stubSatoriApi()));
        await expect(action.run({ guild_id: 1, user_id: "x" })).rejects.toBeInstanceOf(
            SatoriActionError,
        );
        await expect(action.run({ guild_id: 1, user_id: "x" })).rejects.toMatchObject({
            status: 400,
        });
    });
});
