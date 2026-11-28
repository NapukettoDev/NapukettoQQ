import { describe, expect, it, vi } from "vitest";
import { GroupApi } from "../../../src/apis/group/group.js";
import { NTEventChannel } from "../../../src/infra/event-channel.js";
import { GroupBridge } from "../../../src/native/bridge/group-bridge.js";
import { GroupCache } from "../../../src/runtime/cache/group-cache.js";
import type {
    Group,
    GroupDetailInfo,
    GroupListener,
    GroupMember,
    NodeIQQNTWrapperSession,
} from "../../../src/types/index.js";
import { GroupListUpdateType, GroupMemberDataSource } from "../../../src/types/index.js";

const group = (groupName: string, groupCode = "100"): Group => ({
    groupCode,
    groupName,
    memberCount: 1,
    maxMember: 100,
});

const detail = (groupName: string): GroupDetailInfo => ({
    groupCode: "100",
    groupName,
    memberNum: 1,
    maxMemberNum: 100,
});

function fixture() {
    const quit = vi.fn().mockResolvedValue({ result: 0, errMsg: "" });
    const api = new GroupApi({
        getGroupService: () => ({
            getGroupList: vi.fn(),
            getGroupDetailInfo: vi.fn(),
            getAllMemberList: vi.fn(),
            quitGroupV2: quit,
        }),
        getMsgService: () => ({ getMsgsByMsgId: vi.fn() }),
    } as unknown as NodeIQQNTWrapperSession);
    const loadList = vi.spyOn(api, "getGroupList");
    const loadDetail = vi.spyOn(api, "getGroupInfo");
    const loadMembers = vi.spyOn(api, "getGroupMemberList");
    const loadMember = vi.spyOn(api, "getGroupMemberInfo");
    const channel = new NTEventChannel<GroupListener, "Group">("Group");
    const cache = new GroupCache({ channel, groupApi: api });
    cache.register();
    return { api, cache, channel, loadList, loadDetail, loadMembers, loadMember, quit };
}

describe("GroupCache 请求生命周期", () => {
    it("退群再加入后，迟到的详情和成员列表不覆盖新数据", async () => {
        const { api, cache, channel, loadDetail, loadMembers } = fixture();
        const oldDetail = Promise.withResolvers<GroupDetailInfo>();
        const oldMembers = Promise.withResolvers<GroupMember[]>();
        const member = { uid: "u_1", uin: "1", nick: "new" };
        loadDetail.mockReturnValueOnce(oldDetail.promise).mockResolvedValueOnce(detail("new"));
        loadMembers.mockReturnValueOnce(oldMembers.promise).mockResolvedValueOnce([member]);
        const firstDetail = cache.getGroupDetail("100");
        const firstMembers = cache.getMembers("100");
        await api.quitGroup("100");
        channel.emit("Group/onGroupDetailInfoChange", detail("after-quit"));
        expect(cache.hasGroup("100")).toBe(false);

        channel.emit("Group/onGroupListUpdate", GroupListUpdateType.PARTIAL, [group("new")]);
        await expect(cache.getGroupDetail("100")).resolves.toEqual(detail("new"));
        await expect(cache.getMembers("100")).resolves.toEqual([member]);
        oldDetail.resolve(detail("old"));
        oldMembers.resolve([{ ...member, nick: "old" }]);
        await Promise.all([firstDetail, firstMembers]);
        await expect(cache.getGroupDetail("100")).resolves.toEqual(detail("new"));
        await expect(cache.getMember("100", member.uid)).resolves.toEqual(member);
        expect(loadDetail).toHaveBeenCalledTimes(2);
        expect(loadMembers).toHaveBeenCalledTimes(2);
    });

    it("换代后，旧列表和详情请求结束时保留新一代的去重记录", async () => {
        const { cache, loadList, loadDetail } = fixture();
        const oldList = Promise.withResolvers<Group[]>();
        const newList = Promise.withResolvers<Group[]>();
        const oldDetail = Promise.withResolvers<GroupDetailInfo>();
        const newDetail = Promise.withResolvers<GroupDetailInfo>();
        loadList.mockReturnValueOnce(oldList.promise).mockReturnValueOnce(newList.promise);
        loadDetail.mockReturnValueOnce(oldDetail.promise).mockReturnValueOnce(newDetail.promise);
        const firstList = cache.getGroup("100");
        const firstDetail = cache.getGroupDetail("100");

        cache.unregister();
        await expect(cache.getGroupDetail("100")).rejects.toMatchObject({ code: "INVALID_STATE" });
        await expect(cache.getMembers("100")).resolves.toEqual([]);
        await expect(cache.listGroupsRefreshed()).resolves.toEqual([]);
        cache.register();
        const secondList = cache.getGroup("100");
        const secondDetail = cache.getGroupDetail("100");

        oldList.resolve([group("old")]);
        oldDetail.resolve(detail("old"));
        await Promise.all([firstList, firstDetail]);
        expect(cache.listGroups()).toEqual([]);
        expect(cache.hasGroup("100")).toBe(false);
        const sharedList = cache.getGroup("100");
        const sharedDetail = cache.getGroupDetail("100");
        expect(loadList).toHaveBeenCalledTimes(2);
        expect(loadDetail).toHaveBeenCalledTimes(2);

        newList.resolve([group("new")]);
        newDetail.resolve(detail("new"));
        await expect(Promise.all([secondList, sharedList])).resolves.toEqual([
            group("new"),
            group("new"),
        ]);
        await expect(Promise.all([secondDetail, sharedDetail])).resolves.toEqual([
            detail("new"),
            detail("new"),
        ]);
    });

    it("空列表使旧的群列表和成员回填失效，阻止单查接力", async () => {
        const { cache, channel, loadList, loadMembers, loadMember } = fixture();
        const pendingList = Promise.withResolvers<Group[]>();
        const pendingMembers = Promise.withResolvers<GroupMember[]>();
        loadList.mockReturnValueOnce(pendingList.promise);
        loadMembers.mockReturnValueOnce(pendingMembers.promise);
        const list = cache.getGroup("100");
        const member = cache.getMember("100", "u_1");
        channel.emit("Group/onGroupListInited", true);
        pendingList.resolve([group("old")]);
        pendingMembers.resolve([]);
        await expect(list).resolves.toBeUndefined();
        await expect(member).resolves.toBeUndefined();
        expect(loadMember).not.toHaveBeenCalled();
        expect(cache.hasGroup("100")).toBe(false);
    });

    it("迟到的单查不污染退群后重建的成员缓存", async () => {
        const { api, cache, channel, loadMembers, loadMember } = fixture();
        const oldMember = Promise.withResolvers<GroupMember[]>();
        const member = { uid: "u_1", uin: "1", nick: "new" };
        loadMembers.mockResolvedValueOnce([]).mockResolvedValueOnce([member]);
        loadMember.mockReturnValueOnce(oldMember.promise);
        const first = cache.getMember("100", member.uid);
        await vi.waitFor(() => expect(loadMember).toHaveBeenCalledTimes(1));
        await api.quitGroup("100");
        channel.emit("Group/onGroupListUpdate", GroupListUpdateType.PARTIAL, [group("new")]);
        await expect(cache.getMember("100", member.uid)).resolves.toEqual(member);
        oldMember.resolve([{ ...member, nick: "old" }]);
        await first;
        await expect(cache.getMember("100", member.uid)).resolves.toEqual(member);
    });

    it("强制刷新仍等原生事件，完整列表替换且增量列表和成员通知合并", async () => {
        const { cache, channel, loadList, loadMembers } = fixture();
        const nativeRefresh = Promise.withResolvers<Group[]>();
        loadList.mockReturnValueOnce(nativeRefresh.promise);
        const refreshed = cache.listGroupsRefreshed();
        expect(loadList).toHaveBeenCalledWith(true);
        channel.emit("Group/onGroupListUpdate", GroupListUpdateType.ALL, [group("first")]);
        nativeRefresh.resolve([]);
        await expect(refreshed).resolves.toEqual([group("first")]);
        channel.emit("Group/onGroupListUpdate", GroupListUpdateType.PARTIAL, [
            group("second", "200"),
        ]);
        expect(cache.listGroups()).toEqual([group("first"), group("second", "200")]);
        const member = { uid: "u_1", uin: "1", nick: "first" };
        const other = { uid: "u_2", uin: "2" };
        loadMembers.mockResolvedValueOnce([member]);
        await cache.getMembers("100");
        const updated = { ...member, nick: "updated" };
        channel.emit(
            "Group/onMemberInfoChange",
            "100",
            GroupMemberDataSource.NETWORK,
            new Map([
                [updated.uid, updated],
                [other.uid, other],
            ]),
        );
        await expect(cache.getMembers("100")).resolves.toEqual([updated, other]);
        channel.emit("Group/onGroupListUpdate", GroupListUpdateType.ALL, [group("second", "200")]);
        expect(cache.listGroups()).toEqual([group("second", "200")]);
        expect(cache.allowsGroupEvents("100")).toBe(false);
    });

    it("旧桥回调经过重新注册后不能回填新一代列表", () => {
        const { cache, channel } = fixture();
        const listeners: GroupListener[] = [];
        const bridge = new GroupBridge(
            {
                getGroupService: () => ({
                    addKernelGroupListener: (listener: GroupListener) => listeners.push(listener),
                    removeKernelGroupListener: vi.fn(),
                }),
            } as unknown as NodeIQQNTWrapperSession,
            channel,
        );
        bridge.register();
        bridge.unregister();
        cache.unregister();
        cache.register();
        bridge.register();

        listeners[1]?.onGroupListUpdate(GroupListUpdateType.ALL, [group("new")]);
        listeners[0]?.onGroupListUpdate(GroupListUpdateType.ALL, [group("old")]);
        expect(listeners).toHaveLength(2);
        expect(cache.listGroups()).toEqual([group("new")]);
        bridge.unregister();
    });

    it("失败的退群保留缓存，停用后的旧刷新不读取新一代列表", async () => {
        const { api, quit, cache, channel, loadList } = fixture();
        channel.emit("Group/onGroupListUpdate", GroupListUpdateType.ALL, [group("first")]);
        quit.mockResolvedValueOnce({ result: 1, errMsg: "fixture failure" });
        await expect(api.quitGroup("100")).rejects.toThrow();
        expect(cache.listGroups()).toEqual([group("first")]);

        channel.emit("Group/onGroupListInited", true);
        const refresh = Promise.withResolvers<Group[]>();
        loadList.mockReturnValueOnce(refresh.promise);
        const first = cache.listGroupsRefreshed();
        cache.unregister();
        cache.register();
        channel.emit("Group/onGroupListUpdate", GroupListUpdateType.ALL, [group("new")]);
        refresh.resolve([group("old")]);
        await expect(first).resolves.toEqual([]);
        expect(cache.listGroups()).toEqual([group("new")]);
    });
});
