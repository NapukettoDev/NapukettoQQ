/**
 * Milky 社交类动作（P0：get_friend_list / get_group_list；
 * P1 +5：send_profile_like / delete_friend / get_friend_requests /
 * accept_friend_request / reject_friend_request）
 */

import { z } from "zod";
import { findBuddyReq } from "../api.js";
import { groupListToEntity, toFriendEntity } from "../helper/entities.js";
import type {
    FriendRequestEntity,
    GetFriendListOutput,
    GetFriendRequestsOutput,
    GetGroupListOutput,
} from "../types.js";
import { MilkyApiAction } from "./base-action.js";

const emptySchema = z.object({}).strict();

/** get_friend_list：获取好友列表。 */
export class GetFriendListAction extends MilkyApiAction<
    Record<string, never>,
    GetFriendListOutput
> {
    readonly name = "get_friend_list";
    readonly schema = emptySchema;

    protected async _handle(): Promise<GetFriendListOutput> {
        const friends = await this.api.friendApi.getFriendList();
        return {
            friends: friends.map((f) => toFriendEntity(f, f.uin, f.nickname)),
        };
    }
}

/** get_group_list：获取群列表。
 * 实测校准（2026-08-08，OB11 同款）：原生 getGroupList 返回值无数据，列表经
 * onGroupListUpdate 事件进 GroupCache——缓存优先，为空触发刷新回填。
 */
export class GetGroupListAction extends MilkyApiAction<Record<string, never>, GetGroupListOutput> {
    readonly name = "get_group_list";
    readonly schema = emptySchema;

    protected async _handle(): Promise<GetGroupListOutput> {
        const groups =
            this.api.groupCache !== undefined
                ? await this.api.groupCache.listGroupsRefreshed()
                : await this.api.groupApi.getGroupList(true);
        return { groups: groups.map(groupListToEntity) };
    }
}

/** send_profile_like：发送好友赞（count 缺省 1，规范 default 同值）。 */
export class SendProfileLikeAction extends MilkyApiAction<
    { user_id: number; count?: number | null | undefined },
    Record<string, never>
> {
    readonly name = "send_profile_like";
    readonly schema = z.object({
        user_id: z.number().int().min(10001),
        count: z.number().int().min(0).nullable().optional(),
    });

    protected async _handle(payload: {
        user_id: number;
        count?: number | null | undefined;
    }): Promise<Record<string, never>> {
        const uid = await this.api.resolveUidFromUin(payload.user_id);
        await this.api.profileLikeApi.sendLike(uid, payload.count ?? 1);
        return {};
    }
}

/** delete_friend：删除好友。 */
export class DeleteFriendAction extends MilkyApiAction<{ user_id: number }, Record<string, never>> {
    readonly name = "delete_friend";
    readonly schema = z.object({ user_id: z.number().int().min(10001) });

    protected async _handle(payload: { user_id: number }): Promise<Record<string, never>> {
        const uid = await this.api.resolveUidFromUin(payload.user_id);
        await this.api.friendApi.deleteFriend(uid);
        return {};
    }
}

/**
 * get_friend_requests：获取好友请求列表。
 * kernel getBuddyReqList 无过滤/数量参数——is_filtered 入参仅作 schema 兼容
 * （全量返回）；state 无源字段恒 pending（真实状态待探测校准）。
 */
export class GetFriendRequestsAction extends MilkyApiAction<
    { limit?: number | null | undefined; is_filtered?: boolean | null | undefined },
    GetFriendRequestsOutput
> {
    readonly name = "get_friend_requests";
    readonly schema = z.object({
        limit: z.number().int().min(0).nullable().optional(),
        is_filtered: z.boolean().nullable().optional(),
    });

    protected async _handle(payload: {
        limit?: number | null | undefined;
        is_filtered?: boolean | null | undefined;
    }): Promise<GetFriendRequestsOutput> {
        const reqs = await this.api.friendApi.getBuddyReqList();
        // 发起者 uid → uin 批量转换（initiator_id 需要 uin；失败 0 兜底）
        let uidToUin = new Map<string, string>();
        if (reqs.length > 0) {
            uidToUin = await this.api
                .uidToUin(reqs.map((req) => req.friendUid))
                .catch(() => new Map<string, string>());
        }
        const requests: FriendRequestEntity[] = reqs.map((req) => ({
            time: Number(req.reqTime) || 0,
            initiator_id: Number(uidToUin.get(req.friendUid)) || 0,
            initiator_uid: req.friendUid,
            target_user_id: Number(this.api.self.uin),
            target_user_uid: this.api.self.uid ?? "",
            state: "pending",
            comment: typeof req["words"] === "string" ? (req["words"] as string) : "",
            via: req.sourceName ?? "",
            is_filtered: false,
        }));
        const limit = payload.limit ?? requests.length;
        return { requests: requests.slice(0, limit) };
    }
}

/**
 * accept/reject_friend_request 公共基类：initiator_uid → 查申请 → 应答。
 * kernel handleFriendRequest 无 reason 参数（拒绝理由无源，入参仅 schema 兼容）。
 */
abstract class HandleFriendRequestBase extends MilkyApiAction<
    {
        initiator_uid: string;
        is_filtered?: boolean | null | undefined;
        reason?: string | null | undefined;
    },
    Record<string, never>
> {
    readonly schema = z.object({
        initiator_uid: z.string().min(1),
        is_filtered: z.boolean().nullable().optional(),
        reason: z.string().nullable().optional(),
    });

    /** accept=true 同意 / false 拒绝。 */
    protected abstract readonly accept: boolean;

    protected async _handle(payload: {
        initiator_uid: string;
        is_filtered?: boolean | null | undefined;
        reason?: string | null | undefined;
    }): Promise<Record<string, never>> {
        const notify = await findBuddyReq(this.api, payload.initiator_uid);
        await this.api.friendApi.handleFriendRequest(notify, this.accept);
        return {};
    }
}

/** accept_friend_request：同意好友申请。 */
export class AcceptFriendRequestAction extends HandleFriendRequestBase {
    readonly name = "accept_friend_request";
    protected readonly accept = true;
}

/** reject_friend_request：拒绝好友申请。 */
export class RejectFriendRequestAction extends HandleFriendRequestBase {
    readonly name = "reject_friend_request";
    protected readonly accept = false;
}
