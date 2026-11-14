/**
 * get_group_system_msg 动作：获取群系统消息（P2-13 接 kernel GroupNotifyApi）
 *
 * getSingleScreenNotifies(false, count) → type 1=进群邀请 / 7=入群申请。
 * 返回 OB11 结构：invited_requests / InvitedRequest（兼容别名）/ join_requests。
 */

import type { GroupNotify } from "@napuketto/kernel";
import { GroupNotifyMsgType } from "@napuketto/kernel";
import { z } from "zod";
import { BaseAction } from "../../../core/index.js";
import type { OneBotApi } from "../../api/one-bot-api.js";
import { ob11ErrorCodeMap } from "../error-map.js";

const getGroupSystemMsgSchema = z.object({
    count: z.number().optional(),
});

type GetGroupSystemMsgPayload = z.infer<typeof getGroupSystemMsgSchema>;

/** 默认获取数量。 */
const DEFAULT_COUNT = 50;

/** 群系统消息返回结构。 */
export interface GroupSystemMessageInfo {
    request_id: number;
    invitor_uin: number;
    invitor_nick: string;
    group_id: number;
    message: string;
    group_name: string;
    checked: boolean;
    actor: number;
    requester_nick: string;
}

/** 群系统消息返回。 */
export interface GroupSystemMsgResult {
    invited_requests: GroupSystemMessageInfo[];
    InvitedRequest: GroupSystemMessageInfo[];
    join_requests: GroupSystemMessageInfo[];
}

/** 获取群系统消息（P2-13 接 kernel GroupNotifyApi）。 */
export class GetGroupSystemMsgAction extends BaseAction<
    GetGroupSystemMsgPayload,
    GroupSystemMsgResult
> {
    readonly name = "get_group_system_msg";
    readonly schema = getGroupSystemMsgSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly deps: Pick<OneBotApi, "groupNotifyApi" | "uidToUin">;

    constructor(deps: Pick<OneBotApi, "groupNotifyApi" | "uidToUin">) {
        super();
        this.deps = deps;
    }

    protected async _handle(payload: GetGroupSystemMsgPayload): Promise<GroupSystemMsgResult> {
        const count = payload.count ?? DEFAULT_COUNT;
        const notifies = await this.deps.groupNotifyApi.getSingleScreenNotifies(false, count);
        const uinMap = await this.collectUinMap(notifies);
        const invited: GroupSystemMessageInfo[] = [];
        const joined: GroupSystemMessageInfo[] = [];
        for (const notify of notifies) {
            const info = toMessageInfo(notify, uinMap);
            if (notify.type === GroupNotifyMsgType.INVITED_BY_MEMBER) {
                invited.push(info);
            } else if (notify.type === GroupNotifyMsgType.REQUEST_JOIN_NEED_ADMINI_STRATOR_PASS) {
                joined.push(info);
            }
        }
        const result = {
            invited_requests: invited,
            join_requests: joined,
        } as GroupSystemMsgResult;
        // 兼容别名 InvitedRequest（对象字面量 PascalCase 键被 useNamingConvention 拦截，改用索引）
        result["InvitedRequest"] = invited;
        return result;
    }

    /** 收集全部涉及的 uid 批量转 uin（循环外一次请求）。 */
    private async collectUinMap(notifies: GroupNotify[]): Promise<Map<string, string>> {
        const uids: string[] = [];
        for (const notify of notifies) {
            const { user1, user2 } = notify;
            if (user1 !== undefined) {
                const { uid } = user1;
                if (uid !== "") {
                    uids.push(uid);
                }
            }
            if (user2 !== undefined) {
                const { uid } = user2;
                if (uid !== "") {
                    uids.push(uid);
                }
            }
        }
        if (uids.length === 0) {
            return new Map();
        }
        return await this.deps.uidToUin(uids);
    }
}

/** GroupNotify → OB11 群系统消息结构（纯函数，uin 已批量转换）。 */
function toMessageInfo(notify: GroupNotify, uinMap: Map<string, string>): GroupSystemMessageInfo {
    const { seq, status, postscript, user1, user2, group } = notify;
    let user1Uid = "";
    if (user1 !== undefined) {
        const { uid } = user1;
        user1Uid = uid;
    }
    let user2Uid = "";
    if (user2 !== undefined) {
        const { uid } = user2;
        user2Uid = uid;
    }
    let groupCode = 0;
    let groupName = "";
    if (group !== undefined) {
        const { groupCode: code, groupName: name } = group;
        groupCode = Number(code);
        groupName = name;
    }
    let invitorUin = Number(user1Uid);
    const mapped1 = uinMap.get(user1Uid);
    if (mapped1 !== undefined) {
        invitorUin = Number(mapped1);
    }
    let actor = Number(user2Uid);
    const mapped2 = uinMap.get(user2Uid);
    if (mapped2 !== undefined) {
        actor = Number(mapped2);
    }
    let invitorNick = "";
    if (user1 !== undefined) {
        const { nickName } = user1;
        invitorNick = nickName;
    }
    return {
        request_id: Number(seq),
        invitor_uin: invitorUin,
        invitor_nick: invitorNick,
        group_id: groupCode,
        message: postscript ?? "",
        group_name: groupName,
        checked: status !== 1,
        actor,
        requester_nick: invitorNick,
    };
}

/** 群系统消息动作工厂（get_group_system_msg）。 */
export function createGroupSystemMsgActions(api: OneBotApi): BaseAction<unknown, unknown>[] {
    return [new GetGroupSystemMsgAction(api)];
}
