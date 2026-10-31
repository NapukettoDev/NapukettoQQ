/**
 * Milky 社交类动作（P0：get_friend_list / get_group_list；
 * P1 +5：send_profile_like / delete_friend / get_friend_requests /
 * accept_friend_request / reject_friend_request）
 */

import type { Peer } from "@napuketto/kernel";
import { kernelError } from "@napuketto/kernel";
import { z } from "zod";
import { findBuddyReq, type MilkyApi } from "../api.js";
import { groupListToEntity, toFriendEntity } from "../helper/entities.js";
import type {
    FriendRequestEntity,
    GetFriendListOutput,
    GetFriendRequestsOutput,
    GetGroupListOutput,
    GetPeerPinsOutput,
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

/** send_friend_nudge：发送好友戳一戳（is_self=true 戳自己）。 */
export class SendFriendNudgeAction extends MilkyApiAction<
    { user_id: number; is_self?: boolean | null | undefined },
    Record<string, never>
> {
    readonly name = "send_friend_nudge";
    readonly schema = z.object({ user_id: z.number().int().min(10001), is_self: optBoolNudge });

    protected async _handle(payload: {
        user_id: number;
        is_self?: boolean | null | undefined;
    }): Promise<Record<string, never>> {
        const callerUid = requireSelfUid(this.api);
        const receiverUid =
            payload.is_self === true
                ? callerUid
                : await this.api.resolveUidFromUin(payload.user_id);
        const peer = await this.api.resolvePeer("friend", payload.user_id);
        await this.api.msgApi.sendNudge(peer, { receiverUid, callerUid });
        return {};
    }
}

/** get_peer_pins：获取置顶会话（RecentContactApi isTop 过滤，实体经现有翻译）。 */
export class GetPeerPinsAction extends MilkyApiAction<Record<string, never>, GetPeerPinsOutput> {
    readonly name = "get_peer_pins";
    readonly schema = z.object({});

    protected async _handle(): Promise<GetPeerPinsOutput> {
        const pinned = await this.api.recentContactApi.getPinnedContacts();
        const friendUids = pinned.filter((p) => p.scene === "friend").map((p) => p.peerUid);
        const groupCodes = pinned.filter((p) => p.scene === "group").map((p) => p.peerUid);
        const friends = await pinnedFriendEntities(this.api, friendUids);
        const groups = await pinnedGroupEntities(this.api, groupCodes);
        return { friends, groups };
    }
}

/** set_peer_pin：设置/取消会话置顶（is_pinned 缺省 true）。 */
export class SetPeerPinAction extends MilkyApiAction<
    {
        message_scene: "friend" | "group" | "temp";
        peer_id: number;
        is_pinned?: boolean | null | undefined;
    },
    Record<string, never>
> {
    readonly name = "set_peer_pin";
    readonly schema = z.object({
        message_scene: z.enum(["friend", "group", "temp"]),
        peer_id: z.number().int().min(10001),
        is_pinned: optBoolNudge,
    });

    protected async _handle(payload: {
        message_scene: "friend" | "group" | "temp";
        peer_id: number;
        is_pinned?: boolean | null | undefined;
    }): Promise<Record<string, never>> {
        const peer: Peer = await this.api.resolvePeer(payload.message_scene, payload.peer_id);
        await this.api.msgApi.setContactTop(peer, payload.is_pinned ?? true);
        return {};
    }
}

/** 置顶好友实体（uid 匹配全量好友列表；未命中跳过）。 */
async function pinnedFriendEntities(
    api: MilkyApi,
    uids: string[],
): Promise<GetPeerPinsOutput["friends"]> {
    if (uids.length === 0) {
        return [];
    }
    const all = await api.friendApi.getFriendList();
    const byUid = new Map(all.map((f) => [f.uid, f]));
    return uids.flatMap((uid) => {
        const f = byUid.get(uid);
        return f !== undefined ? [toFriendEntity(f, f.uin, f.nickname)] : [];
    });
}

/** 置顶群实体（groupCode 匹配群列表，缓存优先；未命中跳过）。 */
async function pinnedGroupEntities(
    api: MilkyApi,
    groupCodes: string[],
): Promise<GetPeerPinsOutput["groups"]> {
    if (groupCodes.length === 0) {
        return [];
    }
    const groups =
        api.groupCache !== undefined
            ? await api.groupCache.listGroupsRefreshed()
            : await api.groupApi.getGroupList(true);
    const byCode = new Map(groups.map((g) => [g.groupCode, g]));
    return groupCodes.flatMap((code) => {
        const g = byCode.get(code);
        return g !== undefined ? [groupListToEntity(g)] : [];
    });
}

/** self.uid 必备（nudge 发送的 callerUid）。 */
function requireSelfUid(api: MilkyApi): string {
    const uid = api.self.uid;
    if (uid === undefined || uid === "") {
        throw kernelError("登录身份缺 uid（无法发起戳一戳）", "INVALID_PARAM");
    }
    return uid;
}

/** 可选布尔（social.ts 本文件原无 optBool，本地定义避免全局重名）。 */
const optBoolNudge = z.boolean().nullable().optional();
