/**
 * 群查询域动作（2026-11-14 自 get-group-info / get-group-list / get-group-member-info /
 * get-group-member-list / get-group-at-all-remain 合并）
 *
 * P2-4 接 kernel GroupApi；P2-17 群信息/成员动作优先读 GroupCache，no_cache=true
 * 直查 api。get_group_list 有实测校准：原生 getGroupList 返回值无数据（仅
 * { result, errMsg }），列表经 onGroupListUpdate 事件推送 → GroupCache 维护。
 */

import { type GroupApi, type GroupMember, kernelError } from "@napuketto/kernel";
import { z } from "zod";
import { BaseAction } from "../../../core/index.js";
import type { OneBotApi } from "../../api/one-bot-api.js";
import {
    toOb11GroupInfo,
    toOb11GroupInfoDetail,
    toOb11GroupMemberInfo,
} from "../../helper/translate.js";
import type { GroupInfo, GroupMemberInfo } from "../../types/index.js";
import { ob11ErrorCodeMap } from "../error-map.js";

const getGroupInfoSchema = z.object({
    group_id: z.number(),
    /** 是否忽略缓存（go-cqhttp 扩展）。 */
    no_cache: z.boolean().optional(),
});

type GetGroupInfoPayload = z.infer<typeof getGroupInfoSchema>;

/** 获取群信息（P2-4 接 kernel apis/group；P2-17 优先读 GroupCache）。 */
export class GetGroupInfoAction extends BaseAction<GetGroupInfoPayload, GroupInfo> {
    readonly name = "get_group_info";
    readonly schema = getGroupInfoSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly deps: Pick<OneBotApi, "groupApi" | "groupCache">;

    constructor(deps: Pick<OneBotApi, "groupApi" | "groupCache">) {
        super();
        this.deps = deps;
    }

    protected async _handle(payload: GetGroupInfoPayload): Promise<GroupInfo> {
        const groupCode = String(payload.group_id);
        if (payload.no_cache !== true && this.deps.groupCache !== undefined) {
            const detail = await this.deps.groupCache.getGroupDetail(groupCode);
            return toOb11GroupInfoDetail(detail);
        }
        const detail = await this.deps.groupApi.getGroupInfo(groupCode);
        return toOb11GroupInfoDetail(detail);
    }
}

const getGroupListSchema = z.object({
    /** 是否忽略缓存（go-cqhttp 扩展）。 */
    no_cache: z.boolean().optional(),
});

type GetGroupListPayload = z.infer<typeof getGroupListSchema>;

/** 获取群列表（P2-4 接 kernel apis/group；群列表数据经事件推送，从 GroupCache 读）。 */
export class GetGroupListAction extends BaseAction<GetGroupListPayload, GroupInfo[]> {
    readonly name = "get_group_list";
    readonly schema = getGroupListSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly deps: Pick<OneBotApi, "groupApi" | "groupCache">;

    constructor(deps: Pick<OneBotApi, "groupApi" | "groupCache">) {
        super();
        this.deps = deps;
    }

    protected async _handle(payload: GetGroupListPayload): Promise<GroupInfo[]> {
        // 实测校准（2026-08-08）：原生 getGroupList 返回值无数据，列表经
        // onGroupListUpdate 事件推送 → GroupCache 维护；缓存为空时
        // listGroupsRefreshed 主动触发刷新并等待回填。
        // no_cache=true 兼容：始终触发刷新（语义等价缓存必空场景）。
        const groups =
            this.deps.groupCache === undefined
                ? await this.deps.groupApi.getGroupList(true)
                : payload.no_cache === true
                  ? await this.deps.groupCache.listGroupsRefreshed()
                  : this.deps.groupCache.listGroups();
        return groups.map(toOb11GroupInfo);
    }
}

const getGroupMemberInfoSchema = z.object({
    group_id: z.number(),
    user_id: z.number(),
    /** 是否忽略缓存（go-cqhttp 扩展）。 */
    no_cache: z.boolean().optional(),
});

type GetGroupMemberInfoPayload = z.infer<typeof getGroupMemberInfoSchema>;

/** 获取群成员信息（P2-4 接 kernel apis/group；P2-17 优先读 GroupCache）。 */
export class GetGroupMemberInfoAction extends BaseAction<
    GetGroupMemberInfoPayload,
    GroupMemberInfo
> {
    readonly name = "get_group_member_info";
    readonly schema = getGroupMemberInfoSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly deps: Pick<OneBotApi, "groupApi" | "groupCache">;

    constructor(deps: Pick<OneBotApi, "groupApi" | "groupCache">) {
        super();
        this.deps = deps;
    }

    protected async _handle(payload: GetGroupMemberInfoPayload): Promise<GroupMemberInfo> {
        const groupCode = String(payload.group_id);
        // user_id 是 uin：先 uin→uid，再查成员
        const uidMap = await this.deps.groupApi.uinToUid([String(payload.user_id)]);
        const uid = uidMap.get(String(payload.user_id));
        if (uid === undefined) {
            throw kernelError(`成员 ${payload.user_id} 不在群 ${payload.group_id}`, "NOT_FOUND");
        }
        const member = await this.resolveMember(groupCode, uid, payload.no_cache === true);
        if (member === undefined) {
            throw kernelError(`成员 ${payload.user_id} 不在群 ${payload.group_id}`, "NOT_FOUND");
        }
        const uinMap = await this.deps.groupApi.uidToUin([uid]);
        return toOb11GroupMemberInfo(groupCode, member, uinMap);
    }

    /** 读缓存（缺省）或直查 api（no_cache=true / 未装配缓存）。 */
    private async resolveMember(
        groupCode: string,
        uid: string,
        noCache: boolean,
    ): Promise<GroupMember | undefined> {
        if (noCache || this.deps.groupCache === undefined) {
            const members = await this.deps.groupApi.getGroupMemberInfo(groupCode, [uid]);
            const [member] = members;
            return member;
        }
        return await this.deps.groupCache.getMember(groupCode, uid);
    }
}

const getGroupMemberListSchema = z.object({
    group_id: z.number(),
    /** 是否忽略缓存（go-cqhttp 扩展）。 */
    no_cache: z.boolean().optional(),
});

type GetGroupMemberListPayload = z.infer<typeof getGroupMemberListSchema>;

/** 获取群成员列表（P2-4 接 kernel apis/group；P2-17 优先读 GroupCache）。 */
export class GetGroupMemberListAction extends BaseAction<
    GetGroupMemberListPayload,
    GroupMemberInfo[]
> {
    readonly name = "get_group_member_list";
    readonly schema = getGroupMemberListSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly deps: Pick<OneBotApi, "groupApi" | "groupCache">;

    constructor(deps: Pick<OneBotApi, "groupApi" | "groupCache">) {
        super();
        this.deps = deps;
    }

    protected async _handle(payload: GetGroupMemberListPayload): Promise<GroupMemberInfo[]> {
        const groupCode = String(payload.group_id);
        const noCache = payload.no_cache === true;
        let members: GroupMember[];
        if (noCache || this.deps.groupCache === undefined) {
            members = await this.deps.groupApi.getGroupMemberList(groupCode, noCache);
        } else {
            members = await this.deps.groupCache.getMembers(groupCode);
        }
        const uinMap = await this.deps.groupApi.uidToUin(members.map((m) => m.uid));
        return members.map((m) => toOb11GroupMemberInfo(groupCode, m, uinMap));
    }
}

const getGroupAtAllRemainSchema = z.object({
    group_id: z.number(),
});

type GetGroupAtAllRemainPayload = z.infer<typeof getGroupAtAllRemainSchema>;

/** @全体剩余次数返回结构。 */
export interface AtAllRemainInfo {
    can_at_all: boolean;
    remain_at_all_count_for_uin: number;
    remain_at_all_count_for_group: number;
}

/** 获取群 @全体成员 剩余次数（P2-10 接 kernel getGroupRemainAtTimes）。 */
export class GetGroupAtAllRemainAction extends BaseAction<
    GetGroupAtAllRemainPayload,
    AtAllRemainInfo
> {
    readonly name = "get_group_at_all_remain";
    readonly schema = getGroupAtAllRemainSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly groupApi: GroupApi;

    constructor(groupApi: GroupApi) {
        super();
        this.groupApi = groupApi;
    }

    protected async _handle(payload: GetGroupAtAllRemainPayload): Promise<AtAllRemainInfo> {
        const remain = await this.groupApi.getGroupRemainAtTimes(String(payload.group_id));
        return {
            can_at_all: remain.canAtAll,
            remain_at_all_count_for_uin: remain.remainAtAllCountForUin,
            remain_at_all_count_for_group: remain.remainAtAllCountForGroup,
        };
    }
}

/** 群查询域动作工厂（group_info / group_list / member_info / member_list / at_all_remain）。 */
export function createGroupQueryActions(api: OneBotApi): BaseAction<unknown, unknown>[] {
    return [
        new GetGroupInfoAction(api),
        new GetGroupListAction(api),
        new GetGroupMemberInfoAction(api),
        new GetGroupMemberListAction(api),
        new GetGroupAtAllRemainAction(api.groupApi),
    ];
}
