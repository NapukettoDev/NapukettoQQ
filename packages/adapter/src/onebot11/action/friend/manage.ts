/**
 * 好友管理域动作（2026-11-14 自 friend/ 微文件合并）
 *
 * - set_friend_add_request（P2-11）：flag=reqTime（NapCat 约定，需从好友请求事件
 *   上报中获取）→ getBuddyReqList 匹配 → handleFriendRequest + optional remark
 * - set_friend_remark / delete_friend（P2-11）：user_id 经 uin→uid
 * - set_doubt_friends_add_request（P2-11 可疑好友申请处理，NapCat 扩展；
 *   approve 字段 NapCat 强制为 true，该接口无语义仅保留）
 * - send_like（P2-14）：ProfileLikeApi.sendLike
 */

import { type FriendApi, kernelError } from "@napuketto/kernel";
import { z } from "zod";
import { BaseAction } from "../../../core/index.js";
import type { OneBotApi } from "../../api/one-bot-api.js";
import { ob11ErrorCodeMap } from "../error-map.js";
import { resolveUid } from "../resolve-uid.js";

const setDoubtFriendsAddRequestSchema = z.object({
    flag: z.string(),
    approve: z.boolean().optional(),
});

type SetDoubtFriendsAddRequestPayload = z.infer<typeof setDoubtFriendsAddRequestSchema>;

/** 处理可疑好友申请（P2-11 接 kernel handleDoubtFriendRequest）。 */
export class SetDoubtFriendsAddRequestAction extends BaseAction<
    SetDoubtFriendsAddRequestPayload,
    null
> {
    readonly name = "set_doubt_friends_add_request";
    readonly schema = setDoubtFriendsAddRequestSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly friendApi: FriendApi;

    constructor(friendApi: FriendApi) {
        super();
        this.friendApi = friendApi;
    }

    protected _handle(payload: SetDoubtFriendsAddRequestPayload): Promise<null> {
        this.friendApi.handleDoubtFriendRequest(payload.flag);
        return Promise.resolve(null);
    }
}

const setFriendAddRequestSchema = z.object({
    flag: z.string(),
    approve: z.boolean().optional(),
    remark: z.string().optional(),
});

type SetFriendAddRequestPayload = z.infer<typeof setFriendAddRequestSchema>;

/** 处理加好友请求（P2-11 接 kernel FriendApi）。 */
export class SetFriendAddRequestAction extends BaseAction<SetFriendAddRequestPayload, null> {
    readonly name = "set_friend_add_request";
    readonly schema = setFriendAddRequestSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly friendApi: FriendApi;

    constructor(friendApi: FriendApi) {
        super();
        this.friendApi = friendApi;
    }

    protected async _handle(payload: SetFriendAddRequestPayload): Promise<null> {
        const list = await this.friendApi.getBuddyReqList();
        const notify = list.find((req) => req.reqTime === payload.flag);
        if (notify === undefined) {
            throw kernelError("未找到对应的好友请求（flag 无效或已过期）", "NOT_FOUND");
        }
        await this.friendApi.handleFriendRequest(notify, payload.approve !== false);
        if (payload.remark !== undefined) {
            this.friendApi.setFriendRemark(notify.friendUid, payload.remark);
        }
        return null;
    }
}

const setFriendRemarkSchema = z.object({
    user_id: z.number(),
    remark: z.string(),
});

type SetFriendRemarkPayload = z.infer<typeof setFriendRemarkSchema>;

/** 设置好友备注（P2-11 接 kernel setFriendRemark）。 */
export class SetFriendRemarkAction extends BaseAction<SetFriendRemarkPayload, null> {
    readonly name = "set_friend_remark";
    readonly schema = setFriendRemarkSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly deps: Pick<OneBotApi, "friendApi" | "uinToUid">;

    constructor(deps: Pick<OneBotApi, "friendApi" | "uinToUid">) {
        super();
        this.deps = deps;
    }

    protected async _handle(payload: SetFriendRemarkPayload): Promise<null> {
        const uid = await resolveUid(String(payload.user_id), this.deps.uinToUid);
        this.deps.friendApi.setFriendRemark(uid, payload.remark);
        return null;
    }
}

const deleteFriendSchema = z.object({
    user_id: z.number(),
});

type DeleteFriendPayload = z.infer<typeof deleteFriendSchema>;

/** 删除好友（P2-11 接 kernel deleteFriend）。 */
export class DeleteFriendAction extends BaseAction<DeleteFriendPayload, null> {
    readonly name = "delete_friend";
    readonly schema = deleteFriendSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly deps: Pick<OneBotApi, "friendApi" | "uinToUid">;

    constructor(deps: Pick<OneBotApi, "friendApi" | "uinToUid">) {
        super();
        this.deps = deps;
    }

    protected async _handle(payload: DeleteFriendPayload): Promise<null> {
        const uid = await resolveUid(String(payload.user_id), this.deps.uinToUid);
        await this.deps.friendApi.deleteFriend(uid);
        return null;
    }
}

const sendLikeSchema = z.object({
    user_id: z.number(),
    times: z.number().optional(),
});

type SendLikePayload = z.infer<typeof sendLikeSchema>;

/** send_like 依赖（uinToUid 转 uid，OneBotApi 视图）。 */
export type SendLikeDeps = Pick<OneBotApi, "profileLikeApi" | "uinToUid">;

/** 点赞（P2-14 接 kernel ProfileLikeApi）。 */
export class SendLikeAction extends BaseAction<SendLikePayload, null> {
    readonly name = "send_like";
    readonly schema = sendLikeSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly deps: SendLikeDeps;

    constructor(deps: SendLikeDeps) {
        super();
        this.deps = deps;
    }

    protected async _handle(payload: SendLikePayload): Promise<null> {
        const uid = await resolveUid(String(payload.user_id), this.deps.uinToUid);
        await this.deps.profileLikeApi.sendLike(uid, payload.times ?? 1);
        return null;
    }
}

/** 好友管理域动作工厂（friend_add_request / friend_remark / delete_friend /
 * doubt 申请处理 / send_like）。 */
export function createFriendManageActions(api: OneBotApi): BaseAction<unknown, unknown>[] {
    return [
        new SetFriendAddRequestAction(api.friendApi),
        new SetFriendRemarkAction(api),
        new DeleteFriendAction(api),
        new SetDoubtFriendsAddRequestAction(api.friendApi),
        new SendLikeAction(api),
    ];
}
