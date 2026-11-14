/**
 * 群通知域动作（均接 kernel GroupNotifyApi）
 *
 * - get_group_add_request / get_group_ignored_notifies：未处理申请列表 /
 *   可疑忽略列表（getSingleScreenNotifies(false|true)）；flag=seq 用于应答
 * - set_group_add_request：flag=seq 匹配 → handleGroupRequest
 *   （approve=true→同意 / false→拒绝，reason 默认空格）
 * - get_group_shut_list：getGroupShutUpMemberList → 禁言成员列表
 *   （uin 经 uidToUin 批量转换）
 */
import {
    type GroupNotify,
    type GroupNotifyApi,
    kernelError,
    NTGroupRequestOperateTypes,
} from "@napuketto/kernel";
import { z } from "zod";
import type { OneBotApi } from "../../api/one-bot-api.js";
import { defineOb11Action, type Ob11Action } from "../base-action.js";

const getGroupAddRequestSchema = z.object({
    count: z.number().optional(),
});

/** 默认获取数量。 */
const DEFAULT_COUNT = 100;

/** 群请求项 OB11 结构。 */
interface GroupAddRequestItem {
    flag: string;
    group_id: number;
    group_name: string;
    user_id: number;
    user_nick: string;
    type: number;
    checked: boolean;
    postscript: string;
}

/** GroupNotify → OB11 群请求项（纯函数）。 */
function toGroupAddRequestItem(notify: GroupNotify): GroupAddRequestItem {
    const { seq, type, status, postscript, user1, group } = notify;
    let groupCode = 0;
    let groupName = "";
    if (group !== undefined) {
        const { groupCode: code, groupName: name } = group;
        groupCode = Number(code);
        groupName = name;
    }
    let userId = 0;
    let userNick = "";
    if (user1 !== undefined) {
        const { uid, nickName } = user1;
        userId = Number(uid);
        userNick = nickName;
    }
    return {
        flag: seq,
        group_id: groupCode,
        group_name: groupName,
        user_id: userId,
        user_nick: userNick,
        type,
        checked: status !== 1,
        postscript: postscript ?? "",
    };
}

/** 按 seq 匹配通知（先非可疑，后可疑）。 */
async function findGroupNotify(
    groupNotifyApi: GroupNotifyApi,
    flag: string,
    count: number,
): Promise<GroupNotify | null> {
    const normal = await groupNotifyApi.getSingleScreenNotifies(false, count);
    const hit = normal.find((item) => item.seq === flag);
    if (hit !== undefined) {
        return hit;
    }
    const doubt = await groupNotifyApi.getSingleScreenNotifies(true, count);
    return doubt.find((item) => item.seq === flag) ?? null;
}

/** 禁言成员 OB11 结构。 */
interface ShutListMember {
    user_id: number;
    nickname: string;
    shut_up_time: number;
}

/** 群通知域动作工厂（get_group_add_request / get_group_ignored_notifies /
 * set_group_add_request / get_group_shut_list）。 */
export function createGroupNotifyActions(api: OneBotApi): Ob11Action[] {
    return [
        defineOb11Action({
            name: "get_group_add_request",
            schema: getGroupAddRequestSchema,
            handle: async (payload): Promise<GroupAddRequestItem[]> => {
                const list = await api.groupNotifyApi.getSingleScreenNotifies(
                    false,
                    payload.count ?? DEFAULT_COUNT,
                );
                return list.map(toGroupAddRequestItem);
            },
        }),
        defineOb11Action({
            name: "get_group_ignored_notifies",
            schema: getGroupAddRequestSchema,
            handle: async (payload): Promise<GroupAddRequestItem[]> => {
                const list = await api.groupNotifyApi.getSingleScreenNotifies(
                    true,
                    payload.count ?? DEFAULT_COUNT,
                );
                return list.map(toGroupAddRequestItem);
            },
        }),
        defineOb11Action({
            name: "set_group_add_request",
            schema: z.object({
                flag: z.string(),
                approve: z.boolean().optional(),
                reason: z.string().optional(),
                count: z.number().optional(),
            }),
            handle: async (payload) => {
                const count = payload.count ?? DEFAULT_COUNT;
                const notify = await findGroupNotify(api.groupNotifyApi, payload.flag, count);
                if (notify === null) {
                    throw kernelError("未找到对应的群请求（flag 无效或已过期）", "NOT_FOUND");
                }
                let operateType: NTGroupRequestOperateTypes = NTGroupRequestOperateTypes.KREFUSE;
                if (payload.approve !== false) {
                    operateType = NTGroupRequestOperateTypes.KAGREE;
                }
                await api.groupNotifyApi.handleGroupRequest(
                    false,
                    notify,
                    operateType,
                    payload.reason ?? " ",
                );
                return null;
            },
        }),
        defineOb11Action({
            name: "get_group_shut_list",
            schema: z.object({ group_id: z.number() }),
            handle: async (payload): Promise<ShutListMember[]> => {
                const members = await api.groupNotifyApi.getGroupShutUpMemberList(
                    String(payload.group_id),
                );
                const uids = members.map((m) => m.uid);
                let uinMap = new Map<string, string>();
                if (uids.length > 0) {
                    uinMap = await api.uidToUin(uids);
                }
                const out: ShutListMember[] = [];
                for (const member of members) {
                    out.push({
                        user_id: Number(uinMap.get(member.uid) ?? member.uin ?? member.uid),
                        nickname: member.nick,
                        shut_up_time: member.shutUpTime,
                    });
                }
                return out;
            },
        }),
    ];
}
