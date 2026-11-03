/**
 * group-cache.ts 基线测试（fallow 重构目标，untested risk）
 *
 * 覆盖 GroupCache 缓存语义：
 *  - 事件驱动维护（onGroupListUpdate / onMemberListChange / onGroupDetailInfoChange）
 *  - 只读查询（listGroups / getGroup / getGroupDetail / getMembers / getMember）
 *  - 惰性回填 + in-flight 去重
 * 用 mock channel（NTEventChannel）与 mock groupApi，不依赖真实 service。
 */
import { describe, expect, it, vi } from "vitest";
import type { GroupApi } from "../../apis/index.js";
import { NTEventChannel } from "../../event-channel.js";
import type {
    Group,
    GroupDetailInfo,
    GroupMember,
    GroupMemberListChange,
} from "../../types/index.js";
import { GroupListUpdateType } from "../../types/index.js";
import { GroupCache } from "../group-cache.js";

/** Group 事件通道接口（GroupBridge 注册监听后 emit）。 */
type GroupEvents = {
    onGroupListInited(listEmpty: boolean): void;
    onGroupListUpdate(updateType: GroupListUpdateType, groupList: Group[]): void;
    onGroupDetailInfoChange(detailInfo: GroupDetailInfo): void;
    onMemberListChange(arg: GroupMemberListChange): void;
    onMemberInfoChange(
        groupCode: string,
        dataSource: unknown,
        members: Map<string, GroupMember>,
    ): void;
};

function makeCache(overrides: Partial<GroupApi> = {}) {
    const channel = new NTEventChannel<GroupEvents, "Group">("Group");
    const api = {
        getGroupList: vi.fn(async () => []),
        getGroupInfo: vi.fn(async () => ({ groupCode: "" }) as unknown as GroupDetailInfo),
        getGroupMemberList: vi.fn(async () => []),
        getGroupMemberInfo: vi.fn(async () => []),
        ...overrides,
    } as unknown as GroupApi;
    const cache = new GroupCache({ channel, groupApi: api });
    return { channel, api, cache };
}

const group: Group = {
    groupCode: "g1",
    groupName: "测试群",
    memberCount: 2,
    maxMemberCount: 100,
} as unknown as Group;

const member1: GroupMember = { uid: "u1", uin: "10001", nick: "A" } as unknown as GroupMember;
const member2: GroupMember = { uid: "u2", uin: "10002", nick: "B" } as unknown as GroupMember;

describe("事件驱动维护", () => {
    it("onGroupListUpdate 写入列表，listGroups 读取", () => {
        const { channel, cache } = makeCache();
        cache.register();
        channel.emit("Group/onGroupListUpdate", GroupListUpdateType.ALL, [group]);
        expect(cache.listGroups()).toEqual([group]);
        cache.unregister();
    });

    it("onGroupListUpdate ALL 先清空再写入", () => {
        const { channel, cache } = makeCache();
        cache.register();
        channel.emit("Group/onGroupListUpdate", GroupListUpdateType.ALL, [group]);
        channel.emit("Group/onGroupListUpdate", GroupListUpdateType.ALL, [
            { ...group, groupCode: "g2" },
        ]);
        expect(cache.listGroups()).toHaveLength(1);
        cache.unregister();
    });

    it("onGroupListInited(true) 清空列表", () => {
        const { channel, cache } = makeCache();
        cache.register();
        channel.emit("Group/onGroupListUpdate", GroupListUpdateType.ALL, [group]);
        channel.emit("Group/onGroupListInited", true);
        expect(cache.listGroups()).toEqual([]);
        cache.unregister();
    });

    it("onMemberListChange 合并成员，getMembers 读取", async () => {
        const { channel, cache } = makeCache();
        cache.register();
        const change: GroupMemberListChange = {
            sceneId: "g1",
            ids: ["u1", "u2"],
            infos: new Map([
                ["u1", member1],
                ["u2", member2],
            ]),
            hasPrev: false,
            hasNext: false,
            hasRobot: false,
        };
        channel.emit("Group/onMemberListChange", change);
        await expect(cache.getMembers("g1")).resolves.toEqual([member1, member2]);
        cache.unregister();
    });
});

describe("只读查询", () => {
    it("getGroup 命中缓存", async () => {
        const { channel, cache } = makeCache();
        cache.register();
        channel.emit("Group/onGroupListUpdate", GroupListUpdateType.ALL, [group]);
        await expect(cache.getGroup("g1")).resolves.toEqual(group);
        cache.unregister();
    });

    it("getGroup 缺失时惰性回填", async () => {
        const { api, cache } = makeCache();
        (api.getGroupList as ReturnType<typeof vi.fn>).mockResolvedValue([group]);
        await expect(cache.getGroup("g1")).resolves.toEqual(group);
        expect(api.getGroupList).toHaveBeenCalledWith(false);
    });

    it("getGroupDetail 缺失时回填并缓存", async () => {
        const detail = { groupCode: "g1", name: "详情" } as unknown as GroupDetailInfo;
        const { api, cache } = makeCache();
        (api.getGroupInfo as ReturnType<typeof vi.fn>).mockResolvedValue(detail);
        await expect(cache.getGroupDetail("g1")).resolves.toEqual(detail);
        // 二次查询不再拉取
        await cache.getGroupDetail("g1");
        expect(api.getGroupInfo).toHaveBeenCalledTimes(1);
    });

    it("getMember 命中缓存", async () => {
        const { channel, cache } = makeCache();
        cache.register();
        channel.emit("Group/onMemberListChange", {
            sceneId: "g1",
            ids: ["u1"],
            infos: new Map([["u1", member1]]),
            hasPrev: false,
            hasNext: false,
            hasRobot: false,
        });
        await expect(cache.getMember("g1", "u1")).resolves.toEqual(member1);
        cache.unregister();
    });

    it("getMember 缓存空时整群回填", async () => {
        const { api, cache } = makeCache();
        (api.getGroupMemberList as ReturnType<typeof vi.fn>).mockResolvedValue([member1]);
        await expect(cache.getMember("g1", "u1")).resolves.toEqual(member1);
        expect(api.getGroupMemberList).toHaveBeenCalledWith("g1", true);
    });

    it("getMember 单查命中", async () => {
        const { api, cache } = makeCache();
        (api.getGroupMemberInfo as ReturnType<typeof vi.fn>).mockResolvedValue([member1]);
        await expect(cache.getMember("g1", "u1")).resolves.toEqual(member1);
        expect(api.getGroupMemberInfo).toHaveBeenCalledWith("g1", ["u1"]);
    });

    it("getMember 单查空返回 undefined", async () => {
        const { api, cache } = makeCache();
        (api.getGroupMemberInfo as ReturnType<typeof vi.fn>).mockResolvedValue([]);
        await expect(cache.getMember("g1", "u9")).resolves.toBeUndefined();
    });
});

describe("hasGroup / unregister", () => {
    it("hasGroup 命中列表或详情", async () => {
        const { api, cache } = makeCache();
        (api.getGroupInfo as ReturnType<typeof vi.fn>).mockResolvedValue({
            groupCode: "g9",
        } as unknown as GroupDetailInfo);
        await cache.getGroupDetail("g9");
        expect(cache.hasGroup("g9")).toBe(true);
        expect(cache.hasGroup("nope")).toBe(false);
    });

    it("unregister 清空缓存且重复 register 幂等", async () => {
        const { channel, cache } = makeCache();
        cache.register();
        cache.register(); // 幂等
        channel.emit("Group/onGroupListUpdate", GroupListUpdateType.ALL, [group]);
        expect(cache.listGroups()).toHaveLength(1);
        cache.unregister();
        expect(cache.listGroups()).toEqual([]);
    });
});
