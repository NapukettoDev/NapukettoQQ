/**
 * Milky 资料类动作（P1）：get_user_profile / get_friend_info / set_avatar /
 * set_nickname / set_bio / get_cookies / get_csrf_token
 *
 * set_avatar 的 uri 经 media-uri 解析（本地路径 / file:// 直用，http(s)/base64
 * 落盘 mediaDir）；get_cookies 输出规范为单字符串（k=v 分号拼接）；
 * get_csrf_token = qun.qq.com cookies 的 skey → bkn（OB11 get_csrf_token 同口径）。
 */
import { kernelError, TicketApi } from "@napuketto/kernel";
import { z } from "zod";
import { toFriendEntity } from "../helper/entities.js";
import { resolveMediaUri } from "../helper/media-uri.js";
import type {
    GetCookiesOutput,
    GetCSRFTokenOutput,
    GetFriendInfoOutput,
    GetUserProfileOutput,
} from "../types.js";
import { MilkyApiAction } from "./base-action.js";

/** CSRF 计算域名（bkn 口径，OB11 get_csrf_token 同源）。 */
const CSRF_DOMAIN = "qun.qq.com";

/** get_user_profile：获取用户个人信息（陌生人信息 API；country/city/school 无源空兜底）。 */
export class GetUserProfileAction extends MilkyApiAction<
    { user_id: number },
    GetUserProfileOutput
> {
    readonly name = "get_user_profile";
    readonly schema = z.object({ user_id: z.number().int().min(10001) });

    protected async _handle(payload: { user_id: number }): Promise<GetUserProfileOutput> {
        const info = await this.api.profileApi.getStrangerInfo(String(payload.user_id));
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
    }
}

/** get_friend_info：获取好友信息（好友列表单查）。 */
export class GetFriendInfoAction extends MilkyApiAction<
    { user_id: number; no_cache?: boolean | null | undefined },
    GetFriendInfoOutput
> {
    readonly name = "get_friend_info";
    readonly schema = z.object({
        user_id: z.number().int().min(10001),
        no_cache: z.boolean().nullable().optional(),
    });

    protected async _handle(payload: {
        user_id: number;
        no_cache?: boolean | null | undefined;
    }): Promise<GetFriendInfoOutput> {
        const uin = String(payload.user_id);
        const friend = (await this.api.friendApi.getFriendList()).find((f) => f.uin === uin);
        if (friend === undefined) {
            throw kernelError(`好友 ${uin} 不存在`, "NOT_FOUND");
        }
        return { friend: toFriendEntity(friend, friend.uin, friend.nickname) };
    }
}

/** set_avatar：设置头像（uri → 本地路径）。 */
export class SetAvatarAction extends MilkyApiAction<{ uri: string }, Record<string, never>> {
    readonly name = "set_avatar";
    readonly schema = z.object({ uri: z.string().min(1) });

    protected async _handle(payload: { uri: string }): Promise<Record<string, never>> {
        const path = await resolveMediaUri(payload.uri, this.api.mediaDir);
        await this.api.profileApi.setHeader(path);
        return {};
    }
}

/** set_nickname：设置昵称。 */
export class SetNicknameAction extends MilkyApiAction<
    { new_nickname: string },
    Record<string, never>
> {
    readonly name = "set_nickname";
    readonly schema = z.object({ new_nickname: z.string() });

    protected async _handle(payload: { new_nickname: string }): Promise<Record<string, never>> {
        await this.api.profileApi.setNickName(payload.new_nickname);
        return {};
    }
}

/** set_bio：设置个性签名。 */
export class SetBioAction extends MilkyApiAction<{ new_bio: string }, Record<string, never>> {
    readonly name = "set_bio";
    readonly schema = z.object({ new_bio: z.string() });

    protected async _handle(payload: { new_bio: string }): Promise<Record<string, never>> {
        await this.api.profileApi.setLongNick(payload.new_bio);
        return {};
    }
}

/** get_cookies：获取 cookies（规范输出为 k=v 分号拼接字符串）。 */
export class GetCookiesAction extends MilkyApiAction<{ domain: string }, GetCookiesOutput> {
    readonly name = "get_cookies";
    readonly schema = z.object({ domain: z.string().min(1) });

    protected async _handle(payload: { domain: string }): Promise<GetCookiesOutput> {
        const cookies = await this.api.ticketApi.getCookies(payload.domain, this.api.self.uin);
        return {
            cookies: Object.entries(cookies)
                .map(([k, v]) => `${k}=${v}`)
                .join("; "),
        };
    }
}

/** get_csrf_token：bkn（qun.qq.com skey 派生，OB11 get_csrf_token 同口径）。 */
export class GetCSRFTokenAction extends MilkyApiAction<Record<string, never>, GetCSRFTokenOutput> {
    readonly name = "get_csrf_token";
    readonly schema = z.object({}).strict();

    protected async _handle(): Promise<GetCSRFTokenOutput> {
        const cookies = await this.api.ticketApi.getCookies(CSRF_DOMAIN, this.api.self.uin);
        return { csrf_token: TicketApi.getBkn(cookies["skey"] ?? "") };
    }
}
