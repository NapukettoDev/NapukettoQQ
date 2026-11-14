/**
 * Satori 好友动作：friend.list / friend.delete / friend.approve
 */
import type { BuddyReq } from "@napuketto/kernel";
import { z } from "zod";
import type { SatoriApi } from "../api/satori-api.js";
import { toUser } from "../helper/index.js";
import type { Friend, List } from "../types/index.js";
import { defineSatoriAction, type SatoriAction } from "./base-action.js";

/** 动作依赖（Pick<SatoriApi> 视图）。 */
export type FriendActionDeps = Pick<SatoriApi, "friendApi" | "uinToUid" | "uidToUin">;

/** 好友动作工厂（friend.list / friend.delete / friend.approve）。 */
export function createFriendActions(deps: FriendActionDeps): SatoriAction[] {
    return [
        defineSatoriAction({
            name: "friend.list",
            schema: z.object({ next: z.string().optional() }),
            handle: async (): Promise<List<Friend>> => {
                const friends = await deps.friendApi.getFriendList();
                const data: Friend[] = friends.map((f) => {
                    const user = toUser(f.uin, f.nickname);
                    const out: Friend = { user };
                    if (f.remark !== "" && f.remark !== f.nickname) {
                        out.nick = f.remark;
                    }
                    return out;
                });
                return { data };
            },
        }),
        defineSatoriAction({
            name: "friend.delete",
            schema: z.object({ user_id: z.string() }),
            handle: async (payload): Promise<void> => {
                const { user_id: userId } = payload;
                const uidMap = await deps.uinToUid([userId]);
                const uid = uidMap.get(userId) ?? userId;
                await deps.friendApi.deleteFriend(uid);
            },
        }),
        defineSatoriAction({
            name: "friend.approve",
            schema: z.object({
                message_id: z.string(),
                approve: z.boolean(),
                comment: z.string().optional(),
            }),
            // 处理好友申请（message_id = 申请方 uin）
            handle: async (payload): Promise<void> => {
                const { message_id: messageId, approve } = payload;
                const notify = await findBuddyReq(deps, messageId);
                await deps.friendApi.handleFriendRequest(notify, approve);
            },
        }),
    ];
}

/** 按 message_id（申请方 uin）查找好友申请。 */
async function findBuddyReq(deps: FriendActionDeps, messageId: string): Promise<BuddyReq> {
    const reqs = await deps.friendApi.getBuddyReqList();
    if (reqs.length === 0) {
        throw new Error("好友申请不存在");
    }
    // 批量 uid → uin（friendUid 为 uid，message_id 为 uin）
    const uinMap = await deps.uidToUin(reqs.map((r) => r.friendUid));
    const found = reqs.find((req) => uinMap.get(req.friendUid) === messageId);
    if (found === undefined) {
        throw new Error("好友申请不存在");
    }
    return found;
}
