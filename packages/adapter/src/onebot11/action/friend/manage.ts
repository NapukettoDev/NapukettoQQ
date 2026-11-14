/**
 * 好友管理域动作
 *
 * - set_friend_add_request：flag=reqTime（NapCat 约定，需从好友请求事件上报中
 *   获取）→ getBuddyReqList 匹配 → handleFriendRequest + optional remark
 * - set_friend_remark / delete_friend：user_id 经 uin→uid
 * - set_doubt_friends_add_request（可疑好友申请处理，NapCat 扩展；approve 字段
 *   NapCat 强制为 true，该接口无语义仅保留）
 * - send_like：ProfileLikeApi.sendLike
 */
import { kernelError } from "@napuketto/kernel";
import { z } from "zod";
import type { OneBotApi } from "../../api/one-bot-api.js";
import { defineOb11Action, type Ob11Action, resolveUid } from "../base-action.js";

/** 好友管理域动作工厂（friend_add_request / friend_remark / delete_friend /
 * doubt 申请处理 / send_like）。 */
export function createFriendManageActions(api: OneBotApi): Ob11Action[] {
    return [
        defineOb11Action({
            name: "set_friend_add_request",
            schema: z.object({
                flag: z.string(),
                approve: z.boolean().optional(),
                remark: z.string().optional(),
            }),
            handle: async (payload) => {
                const list = await api.friendApi.getBuddyReqList();
                const notify = list.find((req) => req.reqTime === payload.flag);
                if (notify === undefined) {
                    throw kernelError("未找到对应的好友请求（flag 无效或已过期）", "NOT_FOUND");
                }
                await api.friendApi.handleFriendRequest(notify, payload.approve !== false);
                if (payload.remark !== undefined) {
                    api.friendApi.setFriendRemark(notify.friendUid, payload.remark);
                }
                return null;
            },
        }),
        defineOb11Action({
            name: "set_friend_remark",
            schema: z.object({ user_id: z.number(), remark: z.string() }),
            handle: async (payload) => {
                const uid = await resolveUid(String(payload.user_id), api.uinToUid);
                api.friendApi.setFriendRemark(uid, payload.remark);
                return null;
            },
        }),
        defineOb11Action({
            name: "delete_friend",
            schema: z.object({ user_id: z.number() }),
            handle: async (payload) => {
                const uid = await resolveUid(String(payload.user_id), api.uinToUid);
                await api.friendApi.deleteFriend(uid);
                return null;
            },
        }),
        defineOb11Action({
            name: "set_doubt_friends_add_request",
            schema: z.object({ flag: z.string(), approve: z.boolean().optional() }),
            handle: async (payload) => {
                api.friendApi.handleDoubtFriendRequest(payload.flag);
                return null;
            },
        }),
        defineOb11Action({
            name: "send_like",
            schema: z.object({ user_id: z.number(), times: z.number().optional() }),
            handle: async (payload) => {
                const uid = await resolveUid(String(payload.user_id), api.uinToUid);
                await api.profileLikeApi.sendLike(uid, payload.times ?? 1);
                return null;
            },
        }),
    ];
}
