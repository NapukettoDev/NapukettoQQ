/**
 * OneBotApi 群成员角色查询测试（sender.role 判定，2026-10-28）
 *
 * 锁定 GroupCache 消费语义：缓存优先、失败软回退 undefined（调用方回退缺省 member）。
 */
import type { GroupCache, GroupMember } from "@napuketto/kernel";
import { NTGroupMemberRole } from "@napuketto/kernel";
import { describe, expect, it, vi } from "vitest";
import { OneBotApi } from "./one-bot-api.js";

/** 构造 GroupMember（缺省最小合法值，overrides 覆盖）。 */
function makeMember(overrides: Partial<GroupMember> = {}): GroupMember {
    return {
        uid: "u1",
        uin: "90001",
        nick: "小明",
        cardName: "",
        remark: "",
        role: NTGroupMemberRole.MEMBER,
        shutUpTime: 0,
        joinTime: "",
        lastSpeakTime: "",
        ...overrides,
    };
}

/** 构造 OneBotApi（kernel apis 全桩，注入假 GroupCache）。 */
function makeApi(groupCache: GroupCache | undefined): OneBotApi {
    return new OneBotApi({
        msgApi: {},
        groupApi: {},
        groupNotifyApi: {},
        friendApi: {},
        ticketApi: {},
        richMediaApi: {},
        profileApi: {},
        profileLikeApi: {},
        webApi: {},
        self: { uin: "10000", nickname: "机器人" },
        system: { appVersion: "test" },
        ...(groupCache !== undefined ? { groupCache } : {}),
    } as unknown as ConstructorParameters<typeof OneBotApi>[0]);
}

describe("OneBotApi.groupMemberRole", () => {
    it("缓存命中 → roleToString 映射", async () => {
        const cache = {
            getMember: vi.fn(async () => makeMember({ role: NTGroupMemberRole.OWNER })),
        } as unknown as GroupCache;
        const role = await makeApi(cache).groupMemberRole("10001", "u1");
        expect(role).toBe("owner");
    });

    it("未装配 groupCache → undefined", async () => {
        const role = await makeApi(undefined).groupMemberRole("10001", "u1");
        expect(role).toBeUndefined();
    });

    it("成员不在群（getMember 返回 undefined）→ undefined", async () => {
        const cache = {
            getMember: vi.fn(async () => undefined),
        } as unknown as GroupCache;
        const role = await makeApi(cache).groupMemberRole("10001", "u1");
        expect(role).toBeUndefined();
    });

    it("缓存查询抛错 → undefined（不阻塞消息上报）", async () => {
        const cache = {
            getMember: vi.fn(async () => {
                throw new Error("backfill failed");
            }),
        } as unknown as GroupCache;
        const role = await makeApi(cache).groupMemberRole("10001", "u1");
        expect(role).toBeUndefined();
    });
});

describe("OneBotApi.groupMemberRoles", () => {
    it("整表读取 → uid → role 映射", async () => {
        const cache = {
            getMembers: vi.fn(async () => [
                makeMember({ uid: "u1", role: NTGroupMemberRole.OWNER }),
                makeMember({ uid: "u2", role: NTGroupMemberRole.ADMIN }),
                makeMember({ uid: "u3", role: NTGroupMemberRole.MEMBER }),
            ]),
        } as unknown as GroupCache;
        const roles = await makeApi(cache).groupMemberRoles("10001");
        expect(roles?.get("u1")).toBe("owner");
        expect(roles?.get("u2")).toBe("admin");
        expect(roles?.get("u3")).toBe("member");
    });

    it("未装配 / 抛错 → undefined", async () => {
        expect(await makeApi(undefined).groupMemberRoles("10001")).toBeUndefined();
        const cache = {
            getMembers: vi.fn(async () => {
                throw new Error("backfill failed");
            }),
        } as unknown as GroupCache;
        expect(await makeApi(cache).groupMemberRoles("10001")).toBeUndefined();
    });
});
