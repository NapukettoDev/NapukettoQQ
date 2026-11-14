/**
 * Milky 资料类动作：get_user_profile / get_friend_info / set_avatar /
 * set_nickname / set_bio / get_cookies / get_csrf_token。
 *
 * set_avatar 的 uri 经 media-uri 解析（本地路径 / file:// 直用，http(s)/base64
 * 落盘 mediaDir）；get_cookies 输出规范为单字符串（k=v 分号拼接）；
 * get_csrf_token = qun.qq.com cookies 的 skey → bkn（OB11 get_csrf_token 同口径）。
 */
import { kernelError, TicketApi } from "@napuketto/kernel";
import { z } from "zod";
import type { MilkyApi } from "../api.js";
import { toFriendEntity } from "../helper/message/entities.js";
import { resolveMediaUri } from "../helper/message/media-uri.js";
import type {
    GetCookiesOutput,
    GetCSRFTokenOutput,
    GetFriendInfoOutput,
    GetUserProfileOutput,
} from "../types.js";
import { defineMilkyAction, type MilkyAction } from "./base-action.js";

/** CSRF 计算域名（bkn 口径，OB11 get_csrf_token 同源）。 */
const CSRF_DOMAIN = "qun.qq.com";

/** 资料类动作工厂（资料读取 / 头像昵称签名设置 / cookies 与 bkn）。 */
export function createProfileActions(api: MilkyApi): MilkyAction[] {
    return [
        defineMilkyAction({
            name: "get_user_profile",
            schema: z.object({ user_id: z.number().int().min(10001) }),
            // 陌生人信息 API；country/city/school 无源空兜底
            handle: async (payload: { user_id: number }): Promise<GetUserProfileOutput> => {
                const info = await api.profileApi.getStrangerInfo(String(payload.user_id));
                return {
                    nickname: info.nickname,
                    qid: info.qid,
                    age: info.age,
                    sex: info.sex,
                    remark: info.remark,
                    bio: info.long_nick,
                    level: info.qq_level,
                    country: "",
                    city: "",
                    school: "",
                };
            },
        }),
        defineMilkyAction({
            name: "get_friend_info",
            schema: z.object({
                user_id: z.number().int().min(10001),
                no_cache: z.boolean().nullable().optional(),
            }),
            handle: async (payload: {
                user_id: number;
                no_cache?: boolean | null | undefined;
            }): Promise<GetFriendInfoOutput> => {
                const uin = String(payload.user_id);
                const friend = (await api.friendApi.getFriendList()).find((f) => f.uin === uin);
                if (friend === undefined) {
                    throw kernelError(`好友 ${uin} 不存在`, "NOT_FOUND");
                }
                return { friend: toFriendEntity(friend, friend.uin, friend.nickname) };
            },
        }),
        defineMilkyAction({
            name: "set_avatar",
            schema: z.object({ uri: z.string().min(1) }),
            handle: async (payload: { uri: string }) => {
                const path = await resolveMediaUri(payload.uri, api.mediaDir);
                await api.profileApi.setHeader(path);
                return {};
            },
        }),
        defineMilkyAction({
            name: "set_nickname",
            schema: z.object({ new_nickname: z.string() }),
            handle: async (payload: { new_nickname: string }) => {
                await api.profileApi.setNickName(payload.new_nickname);
                return {};
            },
        }),
        defineMilkyAction({
            name: "set_bio",
            schema: z.object({ new_bio: z.string() }),
            handle: async (payload: { new_bio: string }) => {
                await api.profileApi.setLongNick(payload.new_bio);
                return {};
            },
        }),
        defineMilkyAction({
            name: "get_cookies",
            schema: z.object({ domain: z.string().min(1) }),
            handle: async (payload: { domain: string }): Promise<GetCookiesOutput> => {
                const cookies = await api.ticketApi.getCookies(payload.domain, api.self.uin);
                return {
                    cookies: Object.entries(cookies)
                        .map(([k, v]) => `${k}=${v}`)
                        .join("; "),
                };
            },
        }),
        defineMilkyAction({
            name: "get_csrf_token",
            schema: z.object({}).strict(),
            handle: async (): Promise<GetCSRFTokenOutput> => {
                const cookies = await api.ticketApi.getCookies(CSRF_DOMAIN, api.self.uin);
                return { csrf_token: TicketApi.getBkn(cookies["skey"] ?? "") };
            },
        }),
    ];
}
