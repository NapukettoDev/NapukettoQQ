/**
 * GroupCache：群/成员缓存（ADR-008，P2-17，2026-08-05）
 *
 * - 更新：订阅 GroupEventChannel 主动维护（群列表/群详情/成员事件 → 缓存 upsert）。
 * - 回填：只读接口查询缺失时经 GroupApi 惰性拉取（in-flight 去重防并发重复拉）。
 * - 消费：协议翻译层只读消费，禁止调 API（翻译 = 纯函数）。
 *
 * 无全局单例（ADR-015 推论）——每进程每 session 实例化一份，由装配层持有。
 */

import type { GroupApi } from "../apis/index.js";
import type { GroupEventChannel } from "../bridge/index.js";
import { waitFor } from "../infra/index.js";
import type {
    Group,
    GroupDetailInfo,
    GroupMember,
    GroupMemberDataSource,
    GroupMemberListChange,
} from "../types/index.js";
import { GroupListUpdateType } from "../types/index.js";

/** GroupCache 构造参数。 */
export interface GroupCacheOptions {
    /** 群事件通道（GroupBridge 注册原生监听后 emit 到这里）。 */
    channel: GroupEventChannel;
    /** 群 API（惰性回填用）。 */
    groupApi: GroupApi;
}

/**
 * 群/成员缓存：事件主动维护 + 查询惰性回填。
 * 只读接口 getGroupDetail / getMembers / getMember / getGroup（列表项）。
 */
export class GroupCache {
    private readonly channel: GroupEventChannel;
    private readonly groupApi: GroupApi;

    /** 群列表项（onGroupListUpdate / getGroupList 回填）。 */
    private readonly groupList = new Map<string, Group>();
    /** 群详情（onGroupDetailInfoChange / getGroupInfo 回填）。 */
    private readonly groupDetails = new Map<string, GroupDetailInfo>();
    /** 群成员：groupCode → (uid → GroupMember)。 */
    private readonly members = new Map<string, Map<string, GroupMember>>();
    /**
     * 惰性回填 in-flight 去重。
     *
     * 按返回类型拆成三个精确容器：同 key 并发只拉一次，且取回的值类型由容器
     * 声明（Promise<Group[]> / Promise<GroupDetailInfo> / Promise<GroupMember[]>）
     * 自然推导——不再用 `Promise<unknown>` + `as Promise<T>` 假装泛型。
     */
    private inFlightGroupList: Promise<Group[]> | null = null;
    private readonly inFlightDetail = new Map<string, Promise<GroupDetailInfo>>();
    private readonly inFlightMembers = new Map<string, Promise<GroupMember[]>>();

    private unsubscribes: (() => void) | null = null;

    constructor(opts: GroupCacheOptions) {
        this.channel = opts.channel;
        this.groupApi = opts.groupApi;
    }

    /** 订阅群事件通道（幂等）。 */
    register(): void {
        if (this.unsubscribes !== null) {
            return;
        }
        const unsubs: Array<() => void> = [];
        unsubs.push(
            this.channel.on("Group/onGroupListInited", (listEmpty: boolean) => {
                if (listEmpty) {
                    this.groupList.clear();
                }
            }),
        );
        unsubs.push(
            this.channel.on(
                "Group/onGroupListUpdate",
                (updateType: GroupListUpdateType, groupList: Group[]) => {
                    if (updateType === GroupListUpdateType.ALL) {
                        this.groupList.clear();
                    }
                    for (const group of groupList) {
                        this.groupList.set(group.groupCode, group);
                    }
                },
            ),
        );
        unsubs.push(
            this.channel.on("Group/onGroupDetailInfoChange", (detailInfo: GroupDetailInfo) => {
                this.groupDetails.set(detailInfo.groupCode, detailInfo);
            }),
        );
        unsubs.push(
            this.channel.on("Group/onMemberListChange", (arg: GroupMemberListChange) => {
                this.upsertMembers(arg.sceneId, arg.infos);
            }),
        );
        unsubs.push(
            this.channel.on(
                "Group/onMemberInfoChange",
                (
                    _groupCode: string,
                    _dataSource: GroupMemberDataSource,
                    members: Map<string, GroupMember>,
                ) => {
                    this.upsertMembers(_groupCode, members);
                },
            ),
        );
        this.unsubscribes = () => {
            for (const unsub of unsubs) {
                unsub();
            }
        };
    }

    /** 退订事件通道（幂等）。 */
    unregister(): void {
        this.unsubscribes?.();
        this.unsubscribes = null;
        this.groupList.clear();
        this.groupDetails.clear();
        this.members.clear();
        this.inFlightGroupList = null;
        this.inFlightDetail.clear();
        this.inFlightMembers.clear();
    }

    /** 释放（等价 unregister，幂等）。 */
    dispose(): void {
        this.unregister();
    }

    /** `using cache = ...` 自动释放。 */
    [Symbol.dispose](): void {
        this.unregister();
    }

    /** 合并成员到该群缓存（uid → GroupMember）。 */
    private upsertMembers(groupCode: string, infos: Map<string, GroupMember>): void {
        let map = this.members.get(groupCode);
        if (map === undefined) {
            map = new Map();
            this.members.set(groupCode, map);
        }
        for (const [uid, member] of infos) {
            map.set(uid, member);
        }
    }

    /** 群列表是否已有缓存（同步判断）。 */
    hasGroup(groupCode: string): boolean {
        return this.groupList.has(groupCode) || this.groupDetails.has(groupCode);
    }

    /**
     * 群列表快照（只读，缓存由 onGroupListUpdate 事件主动维护）。
     * 群列表数据不走原生 getGroupList 返回值（实测仅 { result, errMsg }，
     * 列表经事件推送）——协议/IPC 层消费列表一律经此方法。
     */
    listGroups(): Group[] {
        return [...this.groupList.values()];
    }

    /**
     * 群列表快照（缓存为空时主动触发原生刷新，等待事件回填后返回）。
     *
     * 实测（2026-08-08 端到端联调）：onGroupListUpdate 仅在登录后首轮同步
     * 推送（MMKV 已有缓存后不再重复推送）——进程内缓存为空时列表读不到。
     * 触发 getGroupList(true) 会重新拉取并推送事件回填缓存。
     * 返回空数组 = 刷新后仍无数据（超时 5s）。
     */
    async listGroupsRefreshed(): Promise<Group[]> {
        if (this.groupList.size > 0) {
            return [...this.groupList.values()];
        }
        await this.groupApi.getGroupList(true);
        await waitFor(() => this.groupList.size > 0, 5_000, 200);
        return [...this.groupList.values()];
    }

    /**
     * 群列表项（只读；缺失惰性回填 getGroupList）。
     * 返回 undefined 表示群不存在。
     */
    async getGroup(groupCode: string): Promise<Group | undefined> {
        const cached = this.groupList.get(groupCode);
        if (cached !== undefined) {
            return cached;
        }
        await this.loadGroupList();
        return this.groupList.get(groupCode);
    }

    /**
     * 群详情（只读；缺失惰性回填 getGroupInfo）。
     * getGroupInfo 恒返回对象（失败抛 KernelError），直接缓存。
     */
    async getGroupDetail(groupCode: string): Promise<GroupDetailInfo> {
        const cached = this.groupDetails.get(groupCode);
        if (cached !== undefined) {
            return cached;
        }
        const detail = await this.dedupeMap(this.inFlightDetail, groupCode, () =>
            this.groupApi.getGroupInfo(groupCode),
        );
        this.groupDetails.set(groupCode, detail);
        return detail;
    }

    /**
     * 群成员列表（只读；缺失惰性回填 getAllMemberList(forceFetch=true)）。
     * 返回空数组表示该群无成员（或拉取失败已由 GroupApi 抛 KernelError）。
     */
    async getMembers(groupCode: string): Promise<GroupMember[]> {
        const map = this.members.get(groupCode);
        if (map !== undefined && map.size > 0) {
            return [...map.values()];
        }
        const members = await this.dedupeMap(this.inFlightMembers, groupCode, () =>
            this.groupApi.getGroupMemberList(groupCode, true),
        );
        const merged = new Map<string, GroupMember>();
        for (const member of members) {
            merged.set(member.uid, member);
        }
        this.members.set(groupCode, merged);
        return members;
    }

    /**
     * 群成员（只读；缺失回填：先整群拉取，再按 uid 取；仍无则 getMemberInfo 单查）。
     * 返回 undefined 表示成员不在群。
     */
    async getMember(groupCode: string, uid: string): Promise<GroupMember | undefined> {
        const cached = await this.getCachedMember(groupCode, uid);
        if (cached !== undefined) {
            return cached;
        }
        const members = await this.dedupeMap(
            this.inFlightMembers,
            `member:${groupCode}:${uid}`,
            () => this.groupApi.getGroupMemberInfo(groupCode, [uid]),
        );
        const [member] = members;
        if (member === undefined) {
            return;
        }
        const target = this.members.get(groupCode);
        if (target !== undefined) {
            target.set(member.uid, member);
        }
        return member;
    }

    /** 读缓存成员（缺失先整群回填一次）。 */
    private async getCachedMember(
        groupCode: string,
        uid: string,
    ): Promise<GroupMember | undefined> {
        let map = this.members.get(groupCode);
        if (map === undefined || map.size === 0) {
            await this.getMembers(groupCode);
            map = this.members.get(groupCode);
        }
        return map?.get(uid);
    }

    /** 惰性回填全量群列表（getGroup 缺失时；并发调用共享同一次拉取）。 */
    private async loadGroupList(): Promise<void> {
        let inFlight = this.inFlightGroupList;
        if (inFlight === null) {
            inFlight = this.groupApi.getGroupList(false).finally(() => {
                this.inFlightGroupList = null;
            });
            this.inFlightGroupList = inFlight;
        }
        for (const group of await inFlight) {
            this.groupList.set(group.groupCode, group);
        }
    }

    /**
     * 惰性回填并发去重（按返回类型分容器）：同 map + key 并发只拉一次。
     * loader 的返回值类型即容器元素类型——取回时由 Promise<T> 自然给出 T，
     * 不需要 `as Promise<T>` 断言。
     */
    private async dedupeMap<T>(
        map: Map<string, Promise<T>>,
        key: string,
        loader: () => Promise<T>,
    ): Promise<T> {
        const existing = map.get(key);
        if (existing !== undefined) {
            return await existing;
        }
        const promise = loader().finally(() => {
            map.delete(key);
        });
        map.set(key, promise);
        return await promise;
    }
}
