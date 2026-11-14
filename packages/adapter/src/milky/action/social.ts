/**
 * Milky 社交类动作：get_friend_list / get_group_list / send_profile_like /
 * delete_friend / get_friend_requests / accept/reject_friend_request /
 * send_friend_nudge / get_peer_pins / set_peer_pin。
 */
import type { Peer } from "@napuketto/kernel";
import { kernelError } from "@napuketto/kernel";
import { z } from "zod";
import { findBuddyReq, type MilkyApi } from "../api.js";
import { groupListToEntity, toFriendEntity } from "../helper/message/entities.js";
import type {
    FriendRequestEntity,
    GetFriendListOutput,
    GetFriendRequestsOutput,
    GetGroupListOutput,
    GetPeerPinsOutput,
} from "../types.js";
import { defineMilkyAction, type MilkyAction } from "./base-action.js";

/** 可选布尔（nudge / pin 入参共用口径）。 */
const optBool = z.boolean().nullable().optional();

/** 社交类动作工厂（好友/群列表、赞、删好友、申请处理、戳一戳、会话置顶）。 */
export function createSocialActions(api: MilkyApi): MilkyAction[] {
    return [
        defineMilkyAction({
            name: "get_friend_list",
            schema: z.object({}).strict(),
            handle: async (): Promise<GetFriendListOutput> => {
                const friends = await api.friendApi.getFriendList();
                return {
                    friends: friends.map((f) => toFriendEntity(f, f.uin, f.nickname)),
                };
            },
        }),
        defineMilkyAction({
            name: "get_group_list",
            schema: z.object({}).strict(),
            // 实测校准（OB11 同款）：原生 getGroupList 返回值无数据，列表经
            // onGroupListUpdate 事件进 GroupCache——缓存优先，为空触发刷新回填。
            handle: async (): Promise<GetGroupListOutput> => {
                const groups =
                    api.groupCache !== undefined
                        ? await api.groupCache.listGroupsRefreshed()
                        : await api.groupApi.getGroupList(true);
                return { groups: groups.map(groupListToEntity) };
            },
        }),
        defineMilkyAction({
            name: "send_profile_like",
            schema: z.object({
                user_id: z.number().int().min(10001),
                count: z.number().int().min(0).nullable().optional(),
            }),
            handle: async (payload: { user_id: number; count?: number | null | undefined }) => {
                const uid = await api.resolveUidFromUin(payload.user_id);
                await api.profileLikeApi.sendLike(uid, payload.count ?? 1);
                return {};
            },
        }),
        defineMilkyAction({
            name: "delete_friend",
            schema: z.object({ user_id: z.number().int().min(10001) }),
            handle: async (payload: { user_id: number }) => {
                const uid = await api.resolveUidFromUin(payload.user_id);
                await api.friendApi.deleteFriend(uid);
                return {};
            },
        }),
        defineMilkyAction({
            name: "get_friend_requests",
            schema: z.object({
                limit: z.number().int().min(0).nullable().optional(),
                is_filtered: z.boolean().nullable().optional(),
            }),
            // kernel getBuddyReqList 无过滤/数量参数——is_filtered 入参仅作 schema 兼容
            // （全量返回）；state 无源字段恒 pending（真实状态待探测校准）。
            handle: async (payload: {
                limit?: number | null | undefined;
                is_filtered?: boolean | null | undefined;
            }): Promise<GetFriendRequestsOutput> => {
                const reqs = await api.friendApi.getBuddyReqList();
                // 发起者 uid → uin 批量转换（initiator_id 需要 uin；失败 0 兜底）
                let uidToUin = new Map<string, string>();
                if (reqs.length > 0) {
                    uidToUin = await api.uidToUin(reqs.map((req) => req.friendUid)).catch((err) => {
                        api.logger?.warn(
                            {
                                count: reqs.length,
                                error: err instanceof Error ? err.message : String(err),
                            },
                            "milky: 好友申请 uid→uin 失败，initiator_id 兜底 0",
                        );
                        return new Map<string, string>();
                    });
                }
                const requests: FriendRequestEntity[] = reqs.map((req) => ({
                    time: Number(req.reqTime) || 0,
                    initiator_id: Number(uidToUin.get(req.friendUid)) || 0,
                    initiator_uid: req.friendUid,
                    target_user_id: Number(api.self.uin),
                    target_user_uid: api.self.uid ?? "",
                    state: "pending",
                    comment: typeof req["words"] === "string" ? (req["words"] as string) : "",
                    via: req.sourceName ?? "",
                    is_filtered: false,
                }));
                const limit = payload.limit ?? requests.length;
                return { requests: requests.slice(0, limit) };
            },
        }),
        defineMilkyAction({
            name: "accept_friend_request",
            schema: friendRequestRespondSchema,
            // kernel handleFriendRequest 无 reason 参数（拒绝理由无源，入参仅 schema 兼容）
            handle: async (payload: { initiator_uid: string }) => {
                const notify = await findBuddyReq(api, payload.initiator_uid);
                await api.friendApi.handleFriendRequest(notify, true);
                return {};
            },
        }),
        defineMilkyAction({
            name: "reject_friend_request",
            schema: friendRequestRespondSchema,
            handle: async (payload: { initiator_uid: string }) => {
                const notify = await findBuddyReq(api, payload.initiator_uid);
                await api.friendApi.handleFriendRequest(notify, false);
                return {};
            },
        }),
        defineMilkyAction({
            name: "send_friend_nudge",
            schema: z.object({ user_id: z.number().int().min(10001), is_self: optBool }),
            // is_self=true 戳自己
            handle: async (payload: { user_id: number; is_self?: boolean | null | undefined }) => {
                const callerUid = requireSelfUid(api);
                const receiverUid =
                    payload.is_self === true
                        ? callerUid
                        : await api.resolveUidFromUin(payload.user_id);
                const peer = await api.resolvePeer("friend", payload.user_id);
                await api.msgApi.sendNudge(peer, { receiverUid, callerUid });
                return {};
            },
        }),
        defineMilkyAction({
            name: "get_peer_pins",
            schema: z.object({}),
            // RecentContactApi isTop 过滤，实体经现有翻译
            handle: async (): Promise<GetPeerPinsOutput> => {
                const pinned = await api.recentContactApi.getPinnedContacts();
                const friendUids = pinned.filter((p) => p.scene === "friend").map((p) => p.peerUid);
                const groupCodes = pinned.filter((p) => p.scene === "group").map((p) => p.peerUid);
                const friends = await pinnedFriendEntities(api, friendUids);
                const groups = await pinnedGroupEntities(api, groupCodes);
                return { friends, groups };
            },
        }),
        defineMilkyAction({
            name: "set_peer_pin",
            schema: z.object({
                message_scene: z.enum(["friend", "group", "temp"]),
                peer_id: z.number().int().min(10001),
                is_pinned: optBool,
            }),
            // is_pinned 缺省 true
            handle: async (payload: {
                message_scene: "friend" | "group" | "temp";
                peer_id: number;
                is_pinned?: boolean | null | undefined;
            }) => {
                const peer: Peer = await api.resolvePeer(payload.message_scene, payload.peer_id);
                await api.msgApi.setContactTop(peer, payload.is_pinned ?? true);
                return {};
            },
        }),
    ];
}

/** accept/reject_friend_request 共入参（is_filtered / reason 仅 schema 兼容）。 */
const friendRequestRespondSchema = z.object({
    initiator_uid: z.string().min(1),
    is_filtered: z.boolean().nullable().optional(),
    reason: z.string().nullable().optional(),
});

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
