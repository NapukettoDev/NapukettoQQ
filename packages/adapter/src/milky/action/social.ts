/**
 * Milky 社交类动作（P0）：get_friend_list / get_group_list
 */
import { z } from "zod";
import type { MilkyApi } from "../api.js";
import { groupListToEntity, toFriendEntity } from "../helper/entities.js";
import type { GetFriendListOutput, GetGroupListOutput } from "../types.js";
import type { MilkyErrorCodeMap } from "./base-action.js";
import { MilkyAction } from "./base-action.js";
import { milkyErrorCodeMap } from "./error-map.js";

const emptySchema = z.object({}).strict();

/** get_friend_list：获取好友列表。 */
export class GetFriendListAction extends MilkyAction<Record<string, never>, GetFriendListOutput> {
    readonly name = "get_friend_list";
    readonly schema = emptySchema;
    protected readonly errorCodeMap: MilkyErrorCodeMap = milkyErrorCodeMap;

    private readonly api: MilkyApi;

    constructor(api: MilkyApi) {
        super();
        this.api = api;
    }

    protected async _handle(): Promise<GetFriendListOutput> {
        const friends = await this.api.friendApi.getFriendList();
        return {
            friends: friends.map((f) => toFriendEntity(f, f.uin, f.nickname)),
        };
    }
}

/**
 * get_group_list：获取群列表。
 * 实测校准（2026-08-08，OB11 同款）：原生 getGroupList 返回值无数据，列表经
 * onGroupListUpdate 事件进 GroupCache——缓存优先，为空触发刷新回填。
 */
export class GetGroupListAction extends MilkyAction<Record<string, never>, GetGroupListOutput> {
    readonly name = "get_group_list";
    readonly schema = emptySchema;
    protected readonly errorCodeMap: MilkyErrorCodeMap = milkyErrorCodeMap;

    private readonly api: MilkyApi;

    constructor(api: MilkyApi) {
        super();
        this.api = api;
    }

    protected async _handle(): Promise<GetGroupListOutput> {
        const groups =
            this.api.groupCache !== undefined
                ? await this.api.groupCache.listGroupsRefreshed()
                : await this.api.groupApi.getGroupList(true);
        return { groups: groups.map(groupListToEntity) };
    }
}
