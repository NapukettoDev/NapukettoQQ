/**
 * 群查询域动作
 *
 * 接 kernel GroupApi；群信息/成员动作优先读 GroupCache，no_cache=true
 * 直查 api。get_group_list 有实测校准：原生 getGroupList 返回值无数据（仅
 * { result, errMsg }），列表经 onGroupListUpdate 事件推送 → GroupCache 维护。
 */
import { type GroupMember, kernelError } from "@napuketto/kernel";
import { z } from "zod";
import type { OneBotApi } from "../../api/one-bot-api.js";
import {
    toOb11GroupInfo,
    toOb11GroupInfoDetail,
    toOb11GroupMemberInfo,
} from "../../helper/translate.js";
import type { GroupInfo, GroupMemberInfo } from "../../types/index.js";
import { defineOb11Action, type Ob11Action } from "../base-action.js";

/** @全体剩余次数返回结构。 */
export interface AtAllRemainInfo {
    can_at_all: boolean;
    remain_at_all_count_for_uin: number;
    remain_at_all_count_for_group: number;
}

/** 群查询域动作工厂（group_info / group_list / member_info / member_list / at_all_remain）。 */
export function createGroupQueryActions(api: OneBotApi): Ob11Action[] {
    return [
        defineOb11Action({
            name: "get_group_info",
            schema: z.object({
                group_id: z.number(),
                /** 是否忽略缓存（go-cqhttp 扩展）。 */
                no_cache: z.boolean().optional(),
            }),
            handle: async (payload): Promise<GroupInfo> => {
                const groupCode = String(payload.group_id);
                if (payload.no_cache !== true && api.groupCache !== undefined) {
                    const detail = await api.groupCache.getGroupDetail(groupCode);
                    return toOb11GroupInfoDetail(detail);
                }
                const detail = await api.groupApi.getGroupInfo(groupCode);
                return toOb11GroupInfoDetail(detail);
            },
        }),
        defineOb11Action({
            name: "get_group_list",
            schema: z.object({
                /** 是否忽略缓存（go-cqhttp 扩展）。 */
                no_cache: z.boolean().optional(),
            }),
            handle: async (payload): Promise<GroupInfo[]> => {
                // 实测校准：原生 getGroupList 返回值无数据，列表经
                // onGroupListUpdate 事件推送 → GroupCache 维护；缓存为空时
                // listGroupsRefreshed 主动触发刷新并等待回填。
                // no_cache=true 兼容：始终触发刷新（语义等价缓存必空场景）。
                const groups =
                    api.groupCache === undefined
                        ? await api.groupApi.getGroupList(true)
                        : payload.no_cache === true
                          ? await api.groupCache.listGroupsRefreshed()
                          : api.groupCache.listGroups();
                return groups.map(toOb11GroupInfo);
            },
        }),
        defineOb11Action({
            name: "get_group_member_info",
            schema: z.object({
                group_id: z.number(),
                user_id: z.number(),
                /** 是否忽略缓存（go-cqhttp 扩展）。 */
                no_cache: z.boolean().optional(),
            }),
            handle: async (payload): Promise<GroupMemberInfo> => {
                const groupCode = String(payload.group_id);
                // user_id 是 uin：先 uin→uid，再查成员
                const uidMap = await api.groupApi.uinToUid([String(payload.user_id)]);
                const uid = uidMap.get(String(payload.user_id));
                if (uid === undefined) {
                    throw kernelError(
                        `成员 ${payload.user_id} 不在群 ${payload.group_id}`,
                        "NOT_FOUND",
                    );
                }
                // 读缓存（缺省）或直查 api（no_cache=true / 未装配缓存）
                let member: GroupMember | undefined;
                if (payload.no_cache === true || api.groupCache === undefined) {
                    const members = await api.groupApi.getGroupMemberInfo(groupCode, [uid]);
                    const [first] = members;
                    member = first;
                } else {
                    member = await api.groupCache.getMember(groupCode, uid);
                }
                if (member === undefined) {
                    throw kernelError(
                        `成员 ${payload.user_id} 不在群 ${payload.group_id}`,
                        "NOT_FOUND",
                    );
                }
                const uinMap = await api.groupApi.uidToUin([uid]);
                return toOb11GroupMemberInfo(groupCode, member, uinMap);
            },
        }),
        defineOb11Action({
            name: "get_group_member_list",
            schema: z.object({
                group_id: z.number(),
                /** 是否忽略缓存（go-cqhttp 扩展）。 */
                no_cache: z.boolean().optional(),
            }),
            handle: async (payload): Promise<GroupMemberInfo[]> => {
                const groupCode = String(payload.group_id);
                const noCache = payload.no_cache === true;
                let members: GroupMember[];
                if (noCache || api.groupCache === undefined) {
                    members = await api.groupApi.getGroupMemberList(groupCode, noCache);
                } else {
                    members = await api.groupCache.getMembers(groupCode);
                }
                const uinMap = await api.groupApi.uidToUin(members.map((m) => m.uid));
                return members.map((m) => toOb11GroupMemberInfo(groupCode, m, uinMap));
            },
        }),
        defineOb11Action({
            name: "get_group_at_all_remain",
            schema: z.object({ group_id: z.number() }),
            handle: async (payload): Promise<AtAllRemainInfo> => {
                const remain = await api.groupApi.getGroupRemainAtTimes(String(payload.group_id));
                return {
                    can_at_all: remain.canAtAll,
                    remain_at_all_count_for_uin: remain.remainAtAllCountForUin,
                    remain_at_all_count_for_group: remain.remainAtAllCountForGroup,
                };
            },
        }),
    ];
}
