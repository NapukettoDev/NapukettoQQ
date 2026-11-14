/**
 * 好友查询域动作（2026-11-14 自 friend/ 微文件合并）
 *
 * - get_friend_list（P2-4）/ get_friends_with_category（P2-11 含分类）：
 *   kernel FriendApi
 * - get_stranger_info（P2-15）：ProfileApi.getStrangerInfo
 * - get_doubt_friends_add_request（P2-11 可疑好友申请，NapCat 扩展）
 */

import type {
    DoubtFriendRequestInfo,
    FriendApi,
    FriendCategory,
    ProfileApi,
    StrangerInfo,
} from "@napuketto/kernel";
import { z } from "zod";
import { BaseAction } from "../../../core/index.js";
import type { OneBotApi } from "../../api/one-bot-api.js";
import type { FriendInfo } from "../../types/index.js";
import { ob11ErrorCodeMap } from "../error-map.js";

const getFriendListSchema = z.object({
    /** 是否忽略缓存（go-cqhttp 扩展）。 */
    no_cache: z.boolean().optional(),
});

type GetFriendListPayload = z.infer<typeof getFriendListSchema>;

/** 获取好友列表（P2-4 接 kernel apis/friend）。 */
export class GetFriendListAction extends BaseAction<GetFriendListPayload, FriendInfo[]> {
    readonly name = "get_friend_list";
    readonly schema = getFriendListSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly friendApi: FriendApi;

    constructor(friendApi: FriendApi) {
        super();
        this.friendApi = friendApi;
    }

    protected async _handle(_payload: GetFriendListPayload): Promise<FriendInfo[]> {
        const friends = await this.friendApi.getFriendList();
        return friends.map((f) => {
            const info: FriendInfo = {
                user_id: Number(f.uin),
                nickname: f.nickname,
            };
            if (f.remark !== "") {
                info.remark = f.remark;
            }
            return info;
        });
    }
}

const getFriendsWithCategorySchema = z.object({});

type GetFriendsWithCategoryPayload = z.infer<typeof getFriendsWithCategorySchema>;

/** 获取好友列表（含分类，P2-11 接 kernel getFriendCategories）。 */
export class GetFriendsWithCategoryAction extends BaseAction<
    GetFriendsWithCategoryPayload,
    FriendCategory[]
> {
    readonly name = "get_friends_with_category";
    readonly schema = getFriendsWithCategorySchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly friendApi: FriendApi;

    constructor(friendApi: FriendApi) {
        super();
        this.friendApi = friendApi;
    }

    protected _handle(_payload: GetFriendsWithCategoryPayload): Promise<FriendCategory[]> {
        return this.friendApi.getFriendCategories();
    }
}

const getStrangerInfoSchema = z.object({
    user_id: z.number(),
    no_cache: z.boolean().optional(),
});

type GetStrangerInfoPayload = z.infer<typeof getStrangerInfoSchema>;

/** 获取陌生人信息（P2-15 接 kernel ProfileApi）。 */
export class GetStrangerInfoAction extends BaseAction<GetStrangerInfoPayload, StrangerInfo> {
    readonly name = "get_stranger_info";
    readonly schema = getStrangerInfoSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly profileApi: ProfileApi;

    constructor(profileApi: ProfileApi) {
        super();
        this.profileApi = profileApi;
    }

    protected async _handle(payload: GetStrangerInfoPayload): Promise<StrangerInfo> {
        const info = await this.profileApi.getStrangerInfo(String(payload.user_id));
        return {
            ...info,
            user_id: payload.user_id,
        };
    }
}

const getDoubtFriendsAddRequestSchema = z.object({
    count: z.number().optional(),
});

type GetDoubtFriendsAddRequestPayload = z.infer<typeof getDoubtFriendsAddRequestSchema>;

/** 默认获取数量。 */
const DEFAULT_COUNT = 50;

/** 获取可疑好友申请（P2-11 接 kernel getDoubtFriendRequest）。 */
export class GetDoubtFriendsAddRequestAction extends BaseAction<
    GetDoubtFriendsAddRequestPayload,
    DoubtFriendRequestInfo[]
> {
    readonly name = "get_doubt_friends_add_request";
    readonly schema = getDoubtFriendsAddRequestSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly friendApi: FriendApi;

    constructor(friendApi: FriendApi) {
        super();
        this.friendApi = friendApi;
    }

    protected _handle(
        payload: GetDoubtFriendsAddRequestPayload,
    ): Promise<DoubtFriendRequestInfo[]> {
        return this.friendApi.getDoubtFriendRequest(payload.count ?? DEFAULT_COUNT);
    }
}

/** 好友查询域动作工厂（friend_list / friends_with_category / stranger_info /
 * doubt_friends_add_request）。 */
export function createFriendQueryActions(api: OneBotApi): BaseAction<unknown, unknown>[] {
    return [
        new GetFriendListAction(api.friendApi),
        new GetFriendsWithCategoryAction(api.friendApi),
        new GetStrangerInfoAction(api.profileApi),
        new GetDoubtFriendsAddRequestAction(api.friendApi),
    ];
}
