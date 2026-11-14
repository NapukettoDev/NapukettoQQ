/**
 * 好友查询域动作
 *
 * - get_friend_list / get_friends_with_category（含分类）：kernel FriendApi
 * - get_stranger_info：ProfileApi.getStrangerInfo
 * - get_doubt_friends_add_request（可疑好友申请，NapCat 扩展）
 */
import type { DoubtFriendRequestInfo, FriendCategory, StrangerInfo } from "@napuketto/kernel";
import { z } from "zod";
import type { OneBotApi } from "../../api/one-bot-api.js";
import type { FriendInfo } from "../../types/index.js";
import { defineOb11Action, type Ob11Action } from "../base-action.js";

/** 可疑好友申请默认获取数量。 */
const DEFAULT_DOUBT_COUNT = 50;

/** 好友查询域动作工厂（friend_list / friends_with_category / stranger_info /
 * doubt_friends_add_request）。 */
export function createFriendQueryActions(api: OneBotApi): Ob11Action[] {
    return [
        defineOb11Action({
            name: "get_friend_list",
            schema: z.object({
                /** 是否忽略缓存（go-cqhttp 扩展）。 */
                no_cache: z.boolean().optional(),
            }),
            handle: async () => {
                const friends = await api.friendApi.getFriendList();
                return friends.map((f) => {
                    const info: FriendInfo = { user_id: Number(f.uin), nickname: f.nickname };
                    if (f.remark !== "") {
                        info.remark = f.remark;
                    }
                    return info;
                });
            },
        }),
        defineOb11Action({
            name: "get_friends_with_category",
            schema: z.object({}),
            handle: (): Promise<FriendCategory[]> => api.friendApi.getFriendCategories(),
        }),
        defineOb11Action({
            name: "get_stranger_info",
            schema: z.object({ user_id: z.number(), no_cache: z.boolean().optional() }),
            handle: async (payload) => {
                const info = await api.profileApi.getStrangerInfo(String(payload.user_id));
                return {
                    ...info,
                    user_id: payload.user_id,
                } satisfies StrangerInfo;
            },
        }),
        defineOb11Action({
            name: "get_doubt_friends_add_request",
            schema: z.object({ count: z.number().optional() }),
            handle: (payload): Promise<DoubtFriendRequestInfo[]> =>
                api.friendApi.getDoubtFriendRequest(payload.count ?? DEFAULT_DOUBT_COUNT),
        }),
    ];
}
