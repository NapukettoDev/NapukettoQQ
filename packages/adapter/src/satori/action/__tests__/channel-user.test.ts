/**
 * satori/action/channel-user.test.ts：channel.get / channel.list / user.get /
 * user.channel.create 单测（同构薄动作合并一文件，表驱动 + 分支用例）。
 *
 * 锁定：
 *  - channel.get：群聊频道补群名（缓存优先）；私聊频道不查缓存
 *  - channel.list：QQ 群组与频道重合 → 单元素列表（缓存群名兜底）
 *  - user.get：getStrangerInfo 昵称兜底 long_nick；失败退化 ID-only
 *  - user.channel.create：私聊频道 id = 对端 uin（无实际创建）
 */
import { ChatType } from "@napuketto/kernel";
import { describe, expect, it, vi } from "vitest";
import { stub } from "../../../shared/__tests__/stub.js";
import type { Channel, List, User } from "../../types/index.js";
import type { ChannelActionDeps } from "../channel.js";
import { createChannelActions } from "../channel.js";
import type { UserActionDeps } from "../user.js";
import { createUserActions } from "../user.js";
import { type StubSatoriApi, satoriActionOf, stubSatoriApi } from "./test-support.js";

function makeChannelDeps(
    api: StubSatoriApi,
    groupCache?: Record<string, never>,
): ChannelActionDeps {
    return stub<ChannelActionDeps>({
        groupApi: api.groupApi,
        selfUin: api.selfUin,
        resolvePeer: api.resolvePeer,
        setChannelType: api.setChannelType,
        ...(groupCache !== undefined ? { groupCache: groupCache as never } : {}),
    });
}

function makeUserDeps(api: StubSatoriApi, groupCache?: Record<string, never>): UserActionDeps {
    return stub<UserActionDeps>({
        profileApi: api.profileApi,
        groupApi: api.groupApi,
        ...(groupCache !== undefined ? { groupCache: groupCache as never } : {}),
    });
}

/** 构造指定频道动作（工厂产物按名取出）。 */
function channelActionOf<R>(api: StubSatoriApi, name: string, groupCache?: Record<string, never>) {
    return satoriActionOf<R>(createChannelActions(makeChannelDeps(api, groupCache)), name);
}

describe("channel.get", () => {
    it("群聊频道：setChannelType(true) + 缓存群名补 name", async () => {
        const api = stubSatoriApi();
        const groupCache = {
            getGroupDetail: async () => ({ groupCode: "10001", groupName: "缓存群名" }),
        };
        const action = channelActionOf<Channel>(api, "channel.get", groupCache as never);
        await expect(action.run({ channel_id: "10001" })).resolves.toEqual({
            id: "10001",
            type: 0,
            name: "缓存群名",
        });
        expect(api.resolvePeer).toHaveBeenCalledWith("10001");
        expect(api.setChannelType).toHaveBeenCalledWith("10001", true);
    });

    it("群聊但缓存缺失 → 不写 name", async () => {
        const api = stubSatoriApi();
        const action = channelActionOf<Channel>(api, "channel.get");
        await expect(action.run({ channel_id: "10001" })).resolves.toEqual({
            id: "10001",
            type: 0,
        });
    });

    it("私聊频道：type=1，不查群缓存", async () => {
        const api = stubSatoriApi();
        api.resolvePeer.mockResolvedValueOnce({
            chatType: ChatType.C2C,
            peerUid: "uid_90001",
        } as never);
        const groupCache = { getGroupDetail: async () => ({ groupName: "不该查" }) };
        const action = channelActionOf<Channel>(api, "channel.get", groupCache as never);
        await expect(action.run({ channel_id: "90001" })).resolves.toEqual({
            id: "90001",
            type: 1,
        });
        expect(api.setChannelType).toHaveBeenCalledWith("90001", false);
    });
});

describe("channel.list", () => {
    it("guild_id → 单元素群聊频道列表（缓存群名兜底）", async () => {
        const api = stubSatoriApi();
        const groupCache = {
            getGroupDetail: async () => ({ groupCode: "10001", groupName: "群名" }),
        };
        const action = channelActionOf<List<Channel>>(api, "channel.list", groupCache as never);
        await expect(action.run({ guild_id: "10001" })).resolves.toEqual({
            data: [{ id: "10001", type: 0, name: "群名" }],
        });
    });

    it("缓存缺失 → 无 name 的单元素列表", async () => {
        const api = stubSatoriApi();
        const action = channelActionOf<List<Channel>>(api, "channel.list");
        await expect(action.run({ guild_id: "10001" })).resolves.toEqual({
            data: [{ id: "10001", type: 0 }],
        });
    });

    it("next 参数允许但不影响结果（QQ 单频道）", async () => {
        const api = stubSatoriApi();
        const action = channelActionOf<List<Channel>>(api, "channel.list");
        const result = await action.run({ guild_id: "10001", next: "cursor" });
        expect(result.data).toHaveLength(1);
        expect(result.next).toBeUndefined();
    });
});

/** 构造指定用户动作（工厂产物按名取出）。 */
function userActionOf<R>(api: StubSatoriApi, name: string, groupCache?: Record<string, never>) {
    return satoriActionOf<R>(createUserActions(makeUserDeps(api, groupCache)), name);
}

describe("user.get", () => {
    it("getStrangerInfo 命中：nickname 优先于 long_nick", async () => {
        const api = stubSatoriApi();
        const action = userActionOf<User>(api, "user.get");
        await expect(action.run({ user_id: "90001" })).resolves.toEqual({
            id: "90001",
            name: "陌生人",
        });
        expect(api.profileApi.getStrangerInfo).toHaveBeenCalledWith("90001");
    });

    it("nickname undefined（防御路径）→ 退化 long_nick", async () => {
        const api = stubSatoriApi();
        vi.mocked(api.profileApi.getStrangerInfo).mockResolvedValueOnce({
            nickname: undefined,
            long_nick: "个性签名",
        } as never);
        const action = userActionOf<User>(api, "user.get");
        await expect(action.run({ user_id: "90001" })).resolves.toEqual({
            id: "90001",
            name: "个性签名",
        });
    });

    it("nickname 为空串（?? 不触发）→ 仅 ID（toUser 空串不写 name）", async () => {
        const api = stubSatoriApi();
        vi.mocked(api.profileApi.getStrangerInfo).mockResolvedValueOnce({
            nickname: "",
            long_nick: "不会用到的签名",
        } as never);
        const action = userActionOf<User>(api, "user.get");
        await expect(action.run({ user_id: "90001" })).resolves.toEqual({ id: "90001" });
    });

    it("陌生人信息查询失败：退化为仅 ID（不抛错）", async () => {
        const api = stubSatoriApi();
        vi.mocked(api.profileApi.getStrangerInfo).mockRejectedValueOnce(new Error("非好友"));
        const action = userActionOf<User>(api, "user.get");
        await expect(action.run({ user_id: "90001" })).resolves.toEqual({ id: "90001" });
    });
});

describe("user.channel.create", () => {
    it("user_id → 私聊频道（type=1，无实际创建）", async () => {
        const action = userActionOf<Channel>(stubSatoriApi(), "user.channel.create");
        await expect(action.run({ user_id: "90001" })).resolves.toEqual({
            id: "90001",
            type: 1,
        });
    });

    it("guild_id 可选透传但不参与结果", async () => {
        const action = userActionOf<Channel>(stubSatoriApi(), "user.channel.create");
        await expect(action.run({ user_id: "90001", guild_id: "10001" })).resolves.toEqual({
            id: "90001",
            type: 1,
        });
    });

    it("缺 user_id → 400", async () => {
        const action = userActionOf<Channel>(stubSatoriApi(), "user.channel.create");
        await expect(action.run({})).rejects.toMatchObject({ status: 400 });
    });
});
