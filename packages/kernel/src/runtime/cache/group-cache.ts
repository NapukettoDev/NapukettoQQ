import type { GroupApi } from "../../apis/index.js";
import { kernelError, waitFor } from "../../infra/index.js";
import type { GroupEventChannel } from "../../native/bridge/index.js";
import type { Group, GroupDetailInfo, GroupMember } from "../../types/index.js";
import { GroupListUpdateType } from "../../types/index.js";
import { GroupMembership } from "./group-membership.js";

export interface GroupCacheOptions {
    channel: GroupEventChannel;
    groupApi: GroupApi;
}

const ALL_MEMBERS = Symbol("all members");

interface GroupState {
    detail?: GroupDetailInfo;
    members: Map<string, GroupMember>;
    detailRequest?: Promise<GroupDetailInfo>;
    memberRequests: Map<string | typeof ALL_MEMBERS, Promise<GroupMember[]>>;
}

interface ListRequest {
    promise?: Promise<void>;
}

/** 群/成员缓存：事件主动维护 + 查询惰性回填。 */
export class GroupCache {
    private readonly channel: GroupEventChannel;
    private readonly groupApi: GroupApi;
    private readonly membership = new GroupMembership();
    private readonly groups = new Map<string, GroupState>();
    private readonly groupList = new Map<string, Group>();
    private listRequest: ListRequest = {};
    private lifetime = new AbortController();
    private unsubscribes: Array<() => void> | null = null;

    constructor(opts: GroupCacheOptions) {
        this.channel = opts.channel;
        this.groupApi = opts.groupApi;
    }

    register(): void {
        if (this.unsubscribes !== null) {
            return;
        }
        if (this.lifetime.signal.aborted) {
            this.lifetime = new AbortController();
        }
        const { signal } = this.lifetime;
        this.unsubscribes = [
            this.channel.on("Group/onGroupListInited", (listEmpty) => {
                if (!signal.aborted && listEmpty) {
                    this.updateGroupList(GroupListUpdateType.ALL, []);
                }
            }),
            this.channel.on("Group/onGroupListUpdate", (type, groups) => {
                if (!signal.aborted) {
                    this.updateGroupList(type, groups);
                }
            }),
            this.channel.on("Group/onGroupDetailInfoChange", (detail) => {
                if (!signal.aborted) {
                    const state = this.stateFor(detail.groupCode);
                    if (state !== undefined) {
                        state.detail = detail;
                    }
                }
            }),
            this.channel.on("Group/onMemberListChange", ({ sceneId, infos }) => {
                if (!signal.aborted) {
                    this.upsertMembers(sceneId, infos);
                }
            }),
            this.channel.on("Group/onMemberInfoChange", (groupCode, _source, members) => {
                if (!signal.aborted) {
                    this.upsertMembers(groupCode, members);
                }
            }),
        ];
        const offQuit = this.groupApi.onGroupQuit?.((groupCode) => {
            if (!signal.aborted) {
                this.membership.leave(groupCode);
                this.groups.delete(groupCode);
                this.groupList.delete(groupCode);
                this.listRequest = {};
            }
        });
        if (offQuit !== undefined) {
            this.unsubscribes.push(offQuit);
        }
    }

    unregister(): void {
        this.lifetime.abort(kernelError("群缓存已停用", "INVALID_STATE"));
        for (const off of this.unsubscribes ?? []) {
            off();
        }
        this.unsubscribes = null;
        this.membership.clear();
        this.groupList.clear();
        this.groups.clear();
        this.listRequest = {};
    }

    dispose(): void {
        this.unregister();
    }

    [Symbol.dispose](): void {
        this.unregister();
    }

    private updateGroupList(type: GroupListUpdateType, groups: Group[]): void {
        if (
            type === GroupListUpdateType.ALL ||
            groups.some((group) => !this.membership.allows(group.groupCode))
        ) {
            this.listRequest = {};
        }
        this.membership.update(type, groups);
        if (type === GroupListUpdateType.ALL) {
            this.groupList.clear();
            for (const groupCode of this.groups.keys()) {
                if (!this.membership.allows(groupCode)) {
                    this.groups.delete(groupCode);
                }
            }
        }
        for (const group of groups) {
            this.groupList.set(group.groupCode, group);
        }
    }

    private stateFor(groupCode: string): GroupState | undefined {
        if (!this.membership.allows(groupCode)) {
            return undefined;
        }
        let state = this.groups.get(groupCode);
        if (state === undefined) {
            state = { members: new Map(), memberRequests: new Map() };
            this.groups.set(groupCode, state);
        }
        return state;
    }

    private upsertMembers(groupCode: string, infos: ReadonlyMap<string, GroupMember>): void {
        const state = this.stateFor(groupCode);
        if (state === undefined) {
            return;
        }
        for (const [uid, member] of infos) {
            state.members.set(uid, member);
        }
    }

    hasGroup(groupCode: string): boolean {
        return this.groupList.has(groupCode) || this.groups.get(groupCode)?.detail !== undefined;
    }

    /** 群成员资格尚未同步时，允许实时事件先到。 */
    allowsGroupEvents(groupCode: string): boolean {
        return !this.lifetime.signal.aborted && this.membership.allows(groupCode);
    }

    listGroups(): Group[] {
        return [...this.groupList.values()];
    }

    /**
     * 群列表为空时主动触发刷新，等待原生事件回填。
     * 登录后原生 MMKV 已有缓存时不会重复首推；只有 getGroupList(true) 会重新拉取。
     */
    async listGroupsRefreshed(): Promise<Group[]> {
        const { signal } = this.lifetime;
        if (signal.aborted || this.groupList.size > 0) {
            return this.listGroups();
        }
        await this.groupApi.getGroupList(true);
        await waitFor(() => signal.aborted || this.groupList.size > 0, 5_000, 200);
        return signal.aborted ? [] : this.listGroups();
    }

    async getGroup(groupCode: string): Promise<Group | undefined> {
        const { signal } = this.lifetime;
        if (signal.aborted) {
            return undefined;
        }
        const cached = this.groupList.get(groupCode);
        if (cached !== undefined) {
            return cached;
        }
        await this.loadGroupList();
        return signal.aborted ? undefined : this.groupList.get(groupCode);
    }

    async getGroupDetail(groupCode: string): Promise<GroupDetailInfo> {
        this.lifetime.signal.throwIfAborted();
        const state = this.stateFor(groupCode);
        if (state === undefined) {
            return await this.groupApi.getGroupInfo(groupCode);
        }
        if (state.detail !== undefined) {
            return state.detail;
        }
        state.detailRequest ??= this.groupApi
            .getGroupInfo(groupCode)
            .then((detail) => {
                if (this.groups.get(groupCode) === state) {
                    state.detail = detail;
                }
                return detail;
            })
            .finally(() => {
                delete state.detailRequest;
            });
        return await state.detailRequest;
    }

    async getMembers(groupCode: string): Promise<GroupMember[]> {
        if (this.lifetime.signal.aborted) {
            return [];
        }
        const state = this.stateFor(groupCode);
        return state === undefined
            ? await this.groupApi.getGroupMemberList(groupCode, true)
            : await this.loadMembers(groupCode, state);
    }

    private async loadMembers(groupCode: string, state: GroupState): Promise<GroupMember[]> {
        if (state.members.size > 0) {
            return [...state.members.values()];
        }
        return await this.dedupe(state.memberRequests, ALL_MEMBERS, async () => {
            const members = await this.groupApi.getGroupMemberList(groupCode, true);
            if (this.groups.get(groupCode) === state) {
                for (const member of members) {
                    if (!state.members.has(member.uid)) {
                        state.members.set(member.uid, member);
                    }
                }
            }
            return members;
        });
    }

    async getMember(groupCode: string, uid: string): Promise<GroupMember | undefined> {
        const { signal } = this.lifetime;
        if (signal.aborted) {
            return undefined;
        }
        const state = this.stateFor(groupCode);
        if (state === undefined) {
            const members = await this.groupApi.getGroupMemberList(groupCode, true);
            return signal.aborted
                ? undefined
                : (members.find((member) => member.uid === uid) ??
                      (await this.groupApi.getGroupMemberInfo(groupCode, [uid]))[0]);
        }
        await this.loadMembers(groupCode, state);
        if (this.groups.get(groupCode) !== state) {
            return undefined;
        }
        const cached = state.members.get(uid);
        if (cached !== undefined) {
            return cached;
        }
        const [member] = await this.dedupe(state.memberRequests, uid, async () => {
            const members = await this.groupApi.getGroupMemberInfo(groupCode, [uid]);
            const [member] = members;
            if (member !== undefined && this.groups.get(groupCode) === state) {
                state.members.set(member.uid, member);
            }
            return members;
        });
        return member;
    }

    private async loadGroupList(): Promise<void> {
        const request = this.listRequest;
        request.promise ??= this.groupApi
            .getGroupList(false)
            .then((groups) => {
                if (this.listRequest === request) {
                    for (const group of groups) {
                        if (this.membership.allows(group.groupCode)) {
                            this.groupList.set(group.groupCode, group);
                        }
                    }
                }
            })
            .finally(() => {
                if (this.listRequest === request) {
                    this.listRequest = {};
                }
            });
        await request.promise;
    }

    private async dedupe(
        map: GroupState["memberRequests"],
        key: string | typeof ALL_MEMBERS,
        load: () => Promise<GroupMember[]>,
    ): Promise<GroupMember[]> {
        const current = map.get(key);
        if (current !== undefined) {
            return await current;
        }
        const promise = load().finally(() => {
            if (map.get(key) === promise) {
                map.delete(key);
            }
        });
        map.set(key, promise);
        return await promise;
    }
}
