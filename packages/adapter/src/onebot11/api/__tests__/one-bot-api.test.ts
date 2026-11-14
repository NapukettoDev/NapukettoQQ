/**
 * OneBotApi 群成员角色查询测试（sender.role 判定，2026-10-28）
 *
 * 锁定 GroupCache 消费语义：缓存优先、失败软回退 undefined（调用方回退缺省 member）。
 */
import {
    type FriendApi,
    type GroupApi,
    type GroupCache,
    type GroupMember,
    type GroupNotifyApi,
    type MsgApi,
    NTGroupMemberRole,
    type ProfileApi,
    type ProfileLikeApi,
    type RichMediaApi,
    type TicketApi,
    type WebApi,
} from "@napuketto/kernel";
import { describe, expect, it, vi } from "vitest";
import { stub } from "../../../core/__tests__/stub.js";
import { OneBotApi } from "../one-bot-api.js";

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
    return new OneBotApi(
        stub<ConstructorParameters<typeof OneBotApi>[0]>({
            msgApi: stub<MsgApi>({}),
            groupApi: stub<GroupApi>({}),
            groupNotifyApi: stub<GroupNotifyApi>({}),
            friendApi: stub<FriendApi>({}),
            ticketApi: stub<TicketApi>({}),
            richMediaApi: stub<RichMediaApi>({}),
            profileApi: stub<ProfileApi>({}),
            profileLikeApi: stub<ProfileLikeApi>({}),
            webApi: stub<WebApi>({}),
            self: { uin: "10000", nickname: "机器人" },
            system: { appVersion: "test" },
            ...(groupCache !== undefined ? { groupCache } : {}),
        }),
    );
}

describe("OneBotApi uin/uid 转换委托", () => {
    it("uinToUid / uidToUin 委托 groupApi 对应方法", async () => {
        const uinToUid = vi.fn(async (uins: string[]) => new Map(uins.map((u) => [u, `u${u}`])));
        const uidToUin = vi.fn(
            async (uids: string[]) => new Map(uids.map((u) => [u, u.replace("u", "")])),
        );
        const api = makeApiWithGroupApi({ uinToUid, uidToUin });
        expect(await api.uinToUid(["90001"])).toEqual(new Map([["90001", "u90001"]]));
        expect(await api.uidToUin(["u90001"])).toEqual(new Map([["u90001", "90001"]]));
        expect(uinToUid).toHaveBeenCalledWith(["90001"]);
        expect(uidToUin).toHaveBeenCalledWith(["u90001"]);
    });

    it("裸引用（脱绑）调用仍委托 groupApi（resolveUid 回调场景，issue #110）", async () => {
        const api = makeApiWithGroupApi({
            uinToUid: vi.fn(async (uins: string[]) => new Map(uins.map((u) => [u, `u${u}`]))),
        });
        const detached = api.uinToUid;
        // ESM 严格模式下裸函数调用 this === undefined，未绑定的原型方法在此炸 groupApi
        expect(await detached.call(undefined, ["90001"])).toEqual(new Map([["90001", "u90001"]]));
    });
});

/** 构造 OneBotApi（注入带方法的 groupApi 桩）。 */
function makeApiWithGroupApi(groupApi: Record<string, unknown>): OneBotApi {
    return new OneBotApi(
        stub<ConstructorParameters<typeof OneBotApi>[0]>({
            msgApi: stub<MsgApi>({}),
            groupApi: stub<GroupApi>(groupApi),
            groupNotifyApi: stub<GroupNotifyApi>({}),
            friendApi: stub<FriendApi>({}),
            ticketApi: stub<TicketApi>({}),
            richMediaApi: stub<RichMediaApi>({}),
            profileApi: stub<ProfileApi>({}),
            profileLikeApi: stub<ProfileLikeApi>({}),
            webApi: stub<WebApi>({}),
            self: { uin: "10000", nickname: "机器人" },
            system: { appVersion: "test" },
        }),
    );
}

describe("OneBotApi.groupMemberRole", () => {
    it("缓存命中 → roleToString 映射", async () => {
        const cache = stub<GroupCache>({
            getMember: vi.fn(async () => makeMember({ role: NTGroupMemberRole.OWNER })),
        });
        const role = await makeApi(cache).groupMemberRole("10001", "u1");
        expect(role).toBe("owner");
    });

    it("未装配 groupCache → undefined", async () => {
        const role = await makeApi(undefined).groupMemberRole("10001", "u1");
        expect(role).toBeUndefined();
    });

    it("成员不在群（getMember 返回 undefined）→ undefined", async () => {
        const cache = stub<GroupCache>({
            getMember: vi.fn(async () => undefined),
        });
        const role = await makeApi(cache).groupMemberRole("10001", "u1");
        expect(role).toBeUndefined();
    });

    it("缓存查询抛错 → undefined（不阻塞消息上报）", async () => {
        const cache = stub<GroupCache>({
            getMember: vi.fn(async () => {
                throw new Error("backfill failed");
            }),
        });
        const role = await makeApi(cache).groupMemberRole("10001", "u1");
        expect(role).toBeUndefined();
    });
});

describe("OneBotApi.groupMemberRoles", () => {
    it("整表读取 → uid → role 映射", async () => {
        const cache = stub<GroupCache>({
            getMembers: vi.fn(async () => [
                makeMember({ uid: "u1", role: NTGroupMemberRole.OWNER }),
                makeMember({ uid: "u2", role: NTGroupMemberRole.ADMIN }),
                makeMember({ uid: "u3", role: NTGroupMemberRole.MEMBER }),
            ]),
        });
        const roles = await makeApi(cache).groupMemberRoles("10001");
        expect(roles?.get("u1")).toBe("owner");
        expect(roles?.get("u2")).toBe("admin");
        expect(roles?.get("u3")).toBe("member");
    });

    it("未装配 / 抛错 → undefined", async () => {
        expect(await makeApi(undefined).groupMemberRoles("10001")).toBeUndefined();
        const cache = stub<GroupCache>({
            getMembers: vi.fn(async () => {
                throw new Error("backfill failed");
            }),
        });
        expect(await makeApi(cache).groupMemberRoles("10001")).toBeUndefined();
    });
});
