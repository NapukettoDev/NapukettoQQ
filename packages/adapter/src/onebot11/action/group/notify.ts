/**
 * 群通知域动作（2026-11-14 自 get-group-add-request / set-group-add-request /
 * get-group-shut-list 合并，均接 kernel GroupNotifyApi）
 *
 * - get_group_add_request / get_group_ignored_notifies（P2-15）：未处理申请列表 /
 *   可疑忽略列表（getSingleScreenNotifies(false|true)）；flag=seq 用于应答
 * - set_group_add_request（P2-13）：flag=seq 匹配 → handleGroupRequest
 *   （approve=true→同意 / false→拒绝，reason 默认空格）
 * - get_group_shut_list（P2-13）：getGroupShutUpMemberList → 禁言成员列表
 *   （uin 经 uidToUin 批量转换）
 */

import {
    type GroupNotify,
    type GroupNotifyApi,
    kernelError,
    NTGroupRequestOperateTypes,
} from "@napuketto/kernel";
import { z } from "zod";
import { BaseAction } from "../../../core/index.js";
import type { OneBotApi } from "../../api/one-bot-api.js";
import { ob11ErrorCodeMap } from "../error-map.js";

const getGroupAddRequestSchema = z.object({
    count: z.number().optional(),
});

type GetGroupAddRequestPayload = z.infer<typeof getGroupAddRequestSchema>;

/** 默认获取数量。 */
const DEFAULT_COUNT = 100;

/** 群请求项 OB11 结构。 */
export interface GroupAddRequestItem {
    flag: string;
    group_id: number;
    group_name: string;
    user_id: number;
    user_nick: string;
    type: number;
    checked: boolean;
    postscript: string;
}

/** 获取未处理群申请（P2-15）。 */
export class GetGroupAddRequestAction extends BaseAction<
    GetGroupAddRequestPayload,
    GroupAddRequestItem[]
> {
    readonly name = "get_group_add_request";
    readonly schema = getGroupAddRequestSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly groupNotifyApi: GroupNotifyApi;

    constructor(groupNotifyApi: GroupNotifyApi) {
        super();
        this.groupNotifyApi = groupNotifyApi;
    }

    protected async _handle(payload: GetGroupAddRequestPayload): Promise<GroupAddRequestItem[]> {
        const list = await this.groupNotifyApi.getSingleScreenNotifies(
            false,
            payload.count ?? DEFAULT_COUNT,
        );
        return list.map(toGroupAddRequestItem);
    }
}

/** 获取被忽略群申请（P2-15）。 */
export class GetGroupIgnoredNotifiesAction extends BaseAction<
    GetGroupAddRequestPayload,
    GroupAddRequestItem[]
> {
    readonly name = "get_group_ignored_notifies";
    readonly schema = getGroupAddRequestSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly groupNotifyApi: GroupNotifyApi;

    constructor(groupNotifyApi: GroupNotifyApi) {
        super();
        this.groupNotifyApi = groupNotifyApi;
    }

    protected async _handle(payload: GetGroupAddRequestPayload): Promise<GroupAddRequestItem[]> {
        const list = await this.groupNotifyApi.getSingleScreenNotifies(
            true,
            payload.count ?? DEFAULT_COUNT,
        );
        return list.map(toGroupAddRequestItem);
    }
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

const setGroupAddRequestSchema = z.object({
    flag: z.string(),
    approve: z.boolean().optional(),
    reason: z.string().optional(),
    count: z.number().optional(),
});

type SetGroupAddRequestPayload = z.infer<typeof setGroupAddRequestSchema>;

/** 处理加群请求（P2-13 接 kernel GroupNotifyApi）。 */
export class SetGroupAddRequestAction extends BaseAction<SetGroupAddRequestPayload, null> {
    readonly name = "set_group_add_request";
    readonly schema = setGroupAddRequestSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly groupNotifyApi: GroupNotifyApi;

    constructor(groupNotifyApi: GroupNotifyApi) {
        super();
        this.groupNotifyApi = groupNotifyApi;
    }

    protected async _handle(payload: SetGroupAddRequestPayload): Promise<null> {
        const count = payload.count ?? DEFAULT_COUNT;
        const notify = await this.findNotify(payload.flag, count);
        if (notify === null) {
            throw kernelError("未找到对应的群请求（flag 无效或已过期）", "NOT_FOUND");
        }
        let operateType: NTGroupRequestOperateTypes = NTGroupRequestOperateTypes.KREFUSE;
        if (payload.approve !== false) {
            operateType = NTGroupRequestOperateTypes.KAGREE;
        }
        await this.groupNotifyApi.handleGroupRequest(
            false,
            notify,
            operateType,
            payload.reason ?? " ",
        );
        return null;
    }

    /** 按 seq 匹配通知（先非可疑，后可疑）。 */
    private async findNotify(flag: string, count: number): Promise<GroupNotify | null> {
        const normal = await this.groupNotifyApi.getSingleScreenNotifies(false, count);
        const hit = normal.find((item) => item.seq === flag);
        if (hit !== undefined) {
            return hit;
        }
        const doubt = await this.groupNotifyApi.getSingleScreenNotifies(true, count);
        return doubt.find((item) => item.seq === flag) ?? null;
    }
}

const getGroupShutListSchema = z.object({
    group_id: z.number(),
});

type GetGroupShutListPayload = z.infer<typeof getGroupShutListSchema>;

/** 禁言成员 OB11 结构。 */
export interface ShutListMember {
    user_id: number;
    nickname: string;
    shut_up_time: number;
}

/** 获取群禁言列表（P2-13 接 kernel GroupNotifyApi）。 */
export class GetGroupShutListAction extends BaseAction<GetGroupShutListPayload, ShutListMember[]> {
    readonly name = "get_group_shut_list";
    readonly schema = getGroupShutListSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly deps: Pick<OneBotApi, "groupNotifyApi" | "uidToUin">;

    constructor(deps: Pick<OneBotApi, "groupNotifyApi" | "uidToUin">) {
        super();
        this.deps = deps;
    }

    protected async _handle(payload: GetGroupShutListPayload): Promise<ShutListMember[]> {
        const members = await this.deps.groupNotifyApi.getGroupShutUpMemberList(
            String(payload.group_id),
        );
        const uids = members.map((m) => m.uid);
        let uinMap = new Map<string, string>();
        if (uids.length > 0) {
            uinMap = await this.deps.uidToUin(uids);
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
    }
}

/**
 * 群通知域动作工厂（get_group_add_request / get_group_ignored_notifies /
 * set_group_add_request / get_group_shut_list）。
 */
export function createGroupNotifyActions(api: OneBotApi): BaseAction<unknown, unknown>[] {
    return [
        new GetGroupAddRequestAction(api.groupNotifyApi),
        new GetGroupIgnoredNotifiesAction(api.groupNotifyApi),
        new SetGroupAddRequestAction(api.groupNotifyApi),
        new GetGroupShutListAction(api),
    ];
}
