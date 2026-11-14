/**
 * Satori 好友动作：friend.list / friend.delete / friend.approve
 */
import type { BuddyReq } from "@napuketto/kernel";
import { z } from "zod";
import { findFirstMatch } from "../../core/shared/lookup.js";
import type { SatoriApi } from "../api/satori-api.js";
import { toUser } from "../helper/index.js";
import type { Friend, List } from "../types/index.js";
import { BaseSatoriAction } from "./base-action.js";

/** 动作依赖（Pick<SatoriApi> 视图）。 */
export type FriendActionDeps = Pick<SatoriApi, "friendApi" | "uinToUid" | "uidToUin">;

/** friend.list 参数。 */
const friendListSchema = z.object({
    next: z.string().optional(),
});

/** 获取好友列表。 */
export class FriendListAction extends BaseSatoriAction<
    z.infer<typeof friendListSchema>,
    List<Friend>
> {
    readonly name = "friend.list";
    readonly schema = friendListSchema;
    private readonly deps: FriendActionDeps;

    constructor(deps: FriendActionDeps) {
        super();
        this.deps = deps;
    }

    protected async _handle(_payload: z.infer<typeof friendListSchema>): Promise<List<Friend>> {
        const friends = await this.deps.friendApi.getFriendList();
        const data: Friend[] = friends.map((f) => {
            const user = toUser(f.uin, f.nickname);
            const out: Friend = { user };
            if (f.remark !== "" && f.remark !== f.nickname) {
                out.nick = f.remark;
            }
            return out;
        });
        return { data };
    }
}

/** friend.delete 参数。 */
const friendDeleteSchema = z.object({
    user_id: z.string(),
});

/** 删除好友。 */
export class FriendDeleteAction extends BaseSatoriAction<z.infer<typeof friendDeleteSchema>, void> {
    readonly name = "friend.delete";
    readonly schema = friendDeleteSchema;
    private readonly deps: FriendActionDeps;

    constructor(deps: FriendActionDeps) {
        super();
        this.deps = deps;
    }

    protected async _handle(payload: z.infer<typeof friendDeleteSchema>): Promise<void> {
        const { user_id: userId } = payload;
        const uidMap = await this.deps.uinToUid([userId]);
        const uid = uidMap.get(userId) ?? userId;
        await this.deps.friendApi.deleteFriend(uid);
    }
}

/** friend.approve 参数（处理好友申请）。 */
const friendApproveSchema = z.object({
    message_id: z.string(),
    approve: z.boolean(),
    comment: z.string().optional(),
});

/** 处理好友申请（message_id = 申请方 uin）。 */
export class FriendApproveAction extends BaseSatoriAction<
    z.infer<typeof friendApproveSchema>,
    void
> {
    readonly name = "friend.approve";
    readonly schema = friendApproveSchema;
    private readonly deps: FriendActionDeps;

    constructor(deps: FriendActionDeps) {
        super();
        this.deps = deps;
    }

    protected async _handle(payload: z.infer<typeof friendApproveSchema>): Promise<void> {
        const { message_id: messageId, approve } = payload;
        const notify = await findBuddyReq(this.deps, messageId);
        await this.deps.friendApi.handleFriendRequest(notify, approve);
    }
}

/** 按 message_id（申请方 uin）查找好友申请（骨架走 core findFirstMatch）。 */
async function findBuddyReq(deps: FriendActionDeps, messageId: string): Promise<BuddyReq> {
    const reqs = await deps.friendApi.getBuddyReqList();
    if (reqs.length === 0) {
        throw new Error("好友申请不存在");
    }
    // 批量 uid → uin（friendUid 为 uid，message_id 为 uin）
    const uinMap = await deps.uidToUin(reqs.map((r) => r.friendUid));
    const found = await findFirstMatch(
        [async () => reqs],
        (req) => uinMap.get(req.friendUid) === messageId,
    );
    if (found === undefined) {
        throw new Error("好友申请不存在");
    }
    return found;
}
