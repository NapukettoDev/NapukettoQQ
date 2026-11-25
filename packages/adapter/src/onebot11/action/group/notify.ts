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
    findPendingGroupRequest,
    type GroupNotify,
    type GroupRequestKind,
    kernelError,
    NTGroupRequestOperateTypes,
    toPendingGroupRequest,
} from "@napuketto/kernel";
import { z } from "zod";
import { collectGroupNotifyUids, resolveUin } from "../../../internal/domain/uid-uin.js";
import type { OneBotApi } from "../../api/onebot-api.js";
import { defineOb11Action, type Ob11Action } from "../base-action.js";

const getGroupAddRequestSchema = z.object({
    count: z.number().optional(),
});

/** 默认获取数量。 */
const DEFAULT_COUNT = 100;

/** 群请求项 OB11 结构。 */
interface GroupAddRequestItem {
    flag: string;
    doubt: boolean;
    request_kind?: GroupRequestKind;
    group_id: number;
    group_name: string;
    user_id: number;
    user_nick: string;
    type: number;
    checked: boolean;
    postscript: string;
}

/** GroupNotify → OB11 群请求项（纯函数）。 */
function toGroupAddRequestItem(
    notify: GroupNotify,
    doubt: boolean,
    uinMap: ReadonlyMap<string, string>,
): GroupAddRequestItem {
    const { seq, type, status, postscript, user1, group } = notify;
    let groupCode = 0;
    let groupName = "";
    if (group != null) {
        const { groupCode: code, groupName: name } = group;
        groupCode = Number(code);
        groupName = name;
    }
    let userId = 0;
    let userNick = "";
    if (user1 != null) {
        const { uid, nickName } = user1;
        userId = resolveUin(uid, uinMap);
        userNick = nickName;
    }
    const requestKind = toPendingGroupRequest(notify, doubt)?.request.kind;
    return {
        flag: seq,
        doubt,
        ...(requestKind !== undefined ? { request_kind: requestKind } : {}),
        group_id: groupCode,
        group_name: groupName,
        user_id: userId,
        user_nick: userNick,
        type,
        checked: status !== 1,
        postscript: postscript ?? "",
    };
}

async function listRequests(
    api: OneBotApi,
    doubt: boolean,
    count: number,
): Promise<GroupAddRequestItem[]> {
    const list = await api.groupNotifyApi.getSingleScreenNotifies(doubt, count);
    const uids = collectGroupNotifyUids(list);
    const uinMap = uids.length === 0 ? new Map<string, string>() : await api.uidToUin(uids);
    return list.map((notify) => toGroupAddRequestItem(notify, doubt, uinMap));
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
    const legacyKinds: Record<"add" | "invite", readonly GroupRequestKind[]> = {
        add: ["join_request"],
        invite: ["invitation", "invited_join_request"],
    };
    return [
        defineOb11Action({
            name: "get_group_add_request",
            schema: getGroupAddRequestSchema,
            handle: (payload) => listRequests(api, false, payload.count ?? DEFAULT_COUNT),
        }),
        defineOb11Action({
            name: "get_group_ignored_notifies",
            schema: getGroupAddRequestSchema,
            handle: (payload) => listRequests(api, true, payload.count ?? DEFAULT_COUNT),
        }),
        defineOb11Action({
            name: "set_group_add_request",
            schema: z.object({
                flag: z.string(),
                doubt: z.boolean().optional(),
                group_id: z.int().positive().optional(),
                request_kind: z
                    .enum(["invitation", "invited_join_request", "join_request"])
                    .optional(),
                sub_type: z.enum(["add", "invite"]).optional(),
                approve: z.boolean().optional(),
                reason: z.string().optional(),
                count: z.number().optional(),
            }),
            handle: async (payload) => {
                const count = payload.count ?? DEFAULT_COUNT;
                const kindsFromSubtype =
                    payload.sub_type === undefined ? undefined : legacyKinds[payload.sub_type];
                if (
                    payload.request_kind !== undefined &&
                    kindsFromSubtype?.includes(payload.request_kind) === false
                ) {
                    throw kernelError("群请求的 request_kind 与 sub_type 不一致", "INVALID_PARAM");
                }
                const { request, notify } = await findPendingGroupRequest(
                    api.groupNotifyApi,
                    {
                        seq: payload.flag,
                        doubt: payload.doubt,
                        kind: payload.request_kind ?? kindsFromSubtype,
                        ...(payload.group_id !== undefined
                            ? { groupCode: String(payload.group_id) }
                            : {}),
                    },
                    count,
                );
                let operateType: NTGroupRequestOperateTypes = NTGroupRequestOperateTypes.KREFUSE;
                if (payload.approve !== false) {
                    operateType = NTGroupRequestOperateTypes.KAGREE;
                }
                await api.groupNotifyApi.handleGroupRequest(
                    request.doubt,
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
                        nickname: member.nick ?? "",
                        shut_up_time: member.shutUpTime ?? 0,
                    });
                }
                return out;
            },
        }),
    ];
}
