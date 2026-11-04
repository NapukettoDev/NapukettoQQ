/**
 * group-cache.ts 扩展测试（基线之外）：
 *  - register 幂等 / PARTIAL 更新不清空 / onMemberInfoChange 写入 / onGroupDetailInfoChange
 *  - listGroupsRefreshed：有缓存直返 / 空缓存触发刷新并等事件回填 / 超时返回空
 *  - dedupe 并发去重（同 key 两次并发查询只拉一次 API）
 *  - getCachedMember 缓存空 Map 分支 / getGroupDetail 复用 dedupe
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
const group2: Group = { groupCode: "g2" } as unknown as Group;
const member1: GroupMember = { uid: "u1", uin: "10001", nick: "A" } as unknown as GroupMember;

describe("事件驱动维护补充", () => {
    it("register 幂等：重复 register 只订阅一次（退订函数不叠加）", () => {
        const { channel, cache } = makeCache();
        cache.register();
        cache.register();
        channel.emit("Group/onGroupListUpdate", GroupListUpdateType.PARTIAL, [group]);
        expect(cache.listGroups()).toEqual([group]);
    });

    it("PARTIAL 更新：合并进现有缓存不清空", () => {
        const { channel, cache } = makeCache();
        cache.register();
        channel.emit("Group/onGroupListUpdate", GroupListUpdateType.PARTIAL, [group]);
        channel.emit("Group/onGroupListUpdate", GroupListUpdateType.PARTIAL, [group2]);
        expect(cache.listGroups()).toEqual([group, group2]);
    });

    it("onMemberInfoChange：members Map 写入", async () => {
        const { channel, cache } = makeCache();
        cache.register();
        channel.emit("Group/onMemberInfoChange", "g1", 1, new Map([["u1", member1]]));
        await expect(cache.getMembers("g1")).resolves.toEqual([member1]);
    });

    it("onGroupDetailInfoChange：详情写入（hasGroup 命中详情路径）", async () => {
        const { channel, cache } = makeCache();
        cache.register();
        const detail = { groupCode: "g9", groupName: "d" } as unknown as GroupDetailInfo;
        channel.emit("Group/onGroupDetailInfoChange", detail);
        expect(cache.hasGroup("g9")).toBe(true);
        await expect(cache.getGroupDetail("g9")).resolves.toBe(detail);
    });
});

describe("listGroupsRefreshed", () => {
    it("有缓存 → 直接返回不触发刷新", async () => {
        const { channel, api, cache } = makeCache();
        cache.register();
        channel.emit("Group/onGroupListUpdate", GroupListUpdateType.ALL, [group]);
        await expect(cache.listGroupsRefreshed()).resolves.toEqual([group]);
        expect(api.getGroupList).not.toHaveBeenCalled();
    });

    it("空缓存 → 触发 getGroupList(true)，事件回填后返回", async () => {
        const { channel, api, cache } = makeCache();
        cache.register();
        (api.getGroupList as ReturnType<typeof vi.fn>).mockImplementation(async () => {
            // 原生刷新 → onGroupListUpdate 事件回填
            channel.emit("Group/onGroupListUpdate", GroupListUpdateType.ALL, [group]);
            return { result: 0, errMsg: "" };
        });
        await expect(cache.listGroupsRefreshed()).resolves.toEqual([group]);
        expect(api.getGroupList).toHaveBeenCalledWith(true);
    });

    it("刷新后仍无数据 → 超时返回空数组（fake timers 加速 5s）", async () => {
        vi.useFakeTimers();
        try {
            const { api, cache } = makeCache();
            cache.register();
            const promise = cache.listGroupsRefreshed();
            const assertion = expect(promise).resolves.toEqual([]);
            for (let i = 0; i < 30; i++) {
                await vi.advanceTimersByTimeAsync(200);
            }
            await assertion;
            expect(api.getGroupList).toHaveBeenCalledWith(true);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("并发去重（dedupe）", () => {
    it("同 key 并发查询只拉一次 API（getMembers）", async () => {
        const { api, cache } = makeCache();
        let resolveOnce!: (v: GroupMember[]) => void;
        (api.getGroupMemberList as ReturnType<typeof vi.fn>).mockImplementation(
            () =>
                new Promise<GroupMember[]>((resolve) => {
                    resolveOnce = resolve;
                }),
        );
        cache.register();
        const p1 = cache.getMembers("g1");
        const p2 = cache.getMembers("g1");
        resolveOnce([member1]);
        await Promise.all([p1, p2]);
        expect(api.getGroupMemberList).toHaveBeenCalledTimes(1);
    });

    it("getGroupDetail 并发去重：第二次等同一个 Promise", async () => {
        const { api, cache } = makeCache();
        let resolveOnce!: (v: GroupDetailInfo) => void;
        (api.getGroupInfo as ReturnType<typeof vi.fn>).mockImplementation(
            () =>
                new Promise<GroupDetailInfo>((resolve) => {
                    resolveOnce = resolve;
                }),
        );
        cache.register();
        const p1 = cache.getGroupDetail("g1");
        const p2 = cache.getGroupDetail("g1");
        resolveOnce({ groupCode: "g1" } as unknown as GroupDetailInfo);
        const [r1, r2] = await Promise.all([p1, p2]);
        expect(r1).toBe(r2);
        expect(api.getGroupInfo).toHaveBeenCalledTimes(1);
    });

    it("回填失败 → inFlight 清理，下次查询重新拉取（不缓存失败）", async () => {
        const { api, cache } = makeCache();
        (api.getGroupMemberList as ReturnType<typeof vi.fn>)
            .mockRejectedValueOnce(new Error("boom"))
            .mockResolvedValueOnce([member1]);
        cache.register();
        await expect(cache.getMembers("g1")).rejects.toThrow(/boom/);
        await expect(cache.getMembers("g1")).resolves.toEqual([member1]);
        expect(api.getGroupMemberList).toHaveBeenCalledTimes(2);
    });

    it("成员缓存空 Map（size=0）→ 视为缺失走回填", async () => {
        const { api, cache } = makeCache();
        cache.register();
        // 先写入空成员 Map
        (api.getGroupMemberList as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
        await cache.getMembers("g1");
        expect(api.getGroupMemberList).toHaveBeenCalledTimes(1);
        // 再查具体成员：空 Map 触发 getMember 单查回填
        (api.getGroupMemberInfo as ReturnType<typeof vi.fn>).mockResolvedValueOnce([member1]);
        await expect(cache.getMember("g1", "u1")).resolves.toEqual(member1);
        expect(api.getGroupMemberInfo).toHaveBeenCalledWith("g1", ["u1"]);
    });
});

describe("getGroup 列表回填", () => {
    it("loadGroupList：getGroupList(false) 拉取后写入缓存", async () => {
        const { api, cache } = makeCache();
        // GroupApi.getGroupList 返回纯列表（loadGroupList 直接消费返回值）
        (api.getGroupList as ReturnType<typeof vi.fn>).mockResolvedValueOnce([group]);
        await expect(cache.getGroup("g1")).resolves.toEqual(group);
        expect(api.getGroupList).toHaveBeenCalledWith(false);
    });

    it("回填后仍无该群 → undefined", async () => {
        const { api, cache } = makeCache();
        (api.getGroupList as ReturnType<typeof vi.fn>).mockResolvedValueOnce([group]);
        await expect(cache.getGroup("g404")).resolves.toBeUndefined();
        // 并发第二次命中缓存，不再拉取
        await expect(cache.getGroup("g1")).resolves.toEqual(group);
        expect(api.getGroupList).toHaveBeenCalledTimes(1);
    });
});

describe("事件分支补充", () => {
    it("onGroupListInited(listEmpty=false) → 不清空现有缓存", () => {
        const { channel, cache } = makeCache();
        cache.register();
        channel.emit("Group/onGroupListUpdate", GroupListUpdateType.ALL, [group]);
        channel.emit("Group/onGroupListInited", false);
        expect(cache.listGroups()).toHaveLength(1);
    });

    it("onGroupListInited(listEmpty=true) → 清空缓存（基线分支对照）", () => {
        const { channel, cache } = makeCache();
        cache.register();
        channel.emit("Group/onGroupListUpdate", GroupListUpdateType.ALL, [group]);
        channel.emit("Group/onGroupListInited", true);
        expect(cache.listGroups()).toEqual([]);
    });

    it("onMemberInfoChange 同群二次推送 → 合并进已有 Map（不重建）", async () => {
        const { channel, cache } = makeCache();
        cache.register();
        const member2: GroupMember = {
            uid: "u2",
            uin: "10002",
            nick: "B",
        } as unknown as GroupMember;
        channel.emit("Group/onMemberInfoChange", "g1", 1, new Map([["u1", member1]]));
        channel.emit("Group/onMemberInfoChange", "g1", 0, new Map([["u2", member2]]));
        await expect(cache.getMembers("g1")).resolves.toEqual([member1, member2]);
    });

    it("onMemberListChange 对已有群二次推送 → 直接合并", async () => {
        const { channel, cache } = makeCache();
        cache.register();
        const arg = {
            sceneId: "g1",
            ids: ["u1"],
            infos: new Map([["u1", member1]]),
            hasPrev: false,
            hasNext: false,
            hasRobot: false,
        };
        channel.emit("Group/onMemberListChange", arg);
        channel.emit("Group/onMemberListChange", arg);
        await expect(cache.getMembers("g1")).resolves.toEqual([member1]);
    });
});
