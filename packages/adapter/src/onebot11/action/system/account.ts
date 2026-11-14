/**
 * 账号票据与资料域动作（2026-11-14 自 get-cookies / get-clientkey /
 * get-credentials / profile-actions 合并）
 *
 * - get_cookies（P2-13）：kernel TicketApi.getCookies，domain 缺省 v2.qq.com
 *   （NapCat 行为）；user_id 缺省用机器人自身 uin
 * - get_clientkey（P2-13）：kernel TicketApi.getClientKey
 * - get_csrf_token / get_credentials（P2-15）：qun.qq.com cookies 的 skey → bkn
 *   （csrf 等价物）；get_credentials 返回指定域名 cookies + bkn
 * - set_self_longnick / set_qq_profile / set_qq_avatar（P2-14）：kernel ProfileApi；
 *   set_qq_profile 的 sex 忽略，头像 URL 需先经 cacheDir 下载
 */

import { existsSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { kernelError, type ProfileApi, TicketApi } from "@napuketto/kernel";
import { z } from "zod";
import { BaseAction } from "../../../core/index.js";
import type { OneBotApi } from "../../api/one-bot-api.js";
import { ob11ErrorCodeMap } from "../error-map.js";

/** URL 前缀（头像在线文件识别）。 */
const URL_PREFIX = /^https?:\/\//;

const getCookiesSchema = z.object({
    domain: z.string().optional(),
    user_id: z.number().optional(),
});

type GetCookiesPayload = z.infer<typeof getCookiesSchema>;

/** 默认域名。 */
const DEFAULT_DOMAIN = "v2.qq.com";

/** 获取 cookies（P2-13 接 kernel TicketApi.getCookies）。 */
export class GetCookiesAction extends BaseAction<GetCookiesPayload, Record<string, string>> {
    readonly name = "get_cookies";
    readonly schema = getCookiesSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly deps: Pick<OneBotApi, "ticketApi" | "selfUin">;

    constructor(deps: Pick<OneBotApi, "ticketApi" | "selfUin">) {
        super();
        this.deps = deps;
    }

    protected _handle(payload: GetCookiesPayload): Promise<Record<string, string>> {
        const domain = payload.domain ?? DEFAULT_DOMAIN;
        let uin = this.deps.selfUin;
        if (payload.user_id !== undefined) {
            uin = String(payload.user_id);
        }
        return this.deps.ticketApi.getCookies(domain, uin);
    }
}

const getClientkeySchema = z.object({});

type GetClientkeyPayload = z.infer<typeof getClientkeySchema>;

/** 获取 clientKey（P2-13 接 kernel TicketApi）。 */
export class GetClientkeyAction extends BaseAction<
    GetClientkeyPayload,
    { clientKey: string; keyIndex: string; expireTime: string; url: string }
> {
    readonly name = "get_clientkey";
    readonly schema = getClientkeySchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly ticketApi: TicketApi;

    constructor(ticketApi: TicketApi) {
        super();
        this.ticketApi = ticketApi;
    }

    protected async _handle(_payload: GetClientkeyPayload): Promise<{
        clientKey: string;
        keyIndex: string;
        expireTime: string;
        url: string;
    }> {
        const raw = await this.ticketApi.getClientKey();
        return {
            clientKey: raw.clientKey,
            keyIndex: raw.keyIndex,
            expireTime: raw.expireTime,
            url: raw.url,
        };
    }
}

const getCsrfTokenSchema = z.object({});

type GetCsrfTokenPayload = z.infer<typeof getCsrfTokenSchema>;

/** 默认域名（bkn 计算用）。 */
const BKN_DOMAIN = "qun.qq.com";

/** 获取 csrf_token（bkn，P2-15）。 */
export class GetCsrfTokenAction extends BaseAction<GetCsrfTokenPayload, { token: number }> {
    readonly name = "get_csrf_token";
    readonly schema = getCsrfTokenSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly deps: Pick<OneBotApi, "ticketApi" | "selfUin">;

    constructor(deps: Pick<OneBotApi, "ticketApi" | "selfUin">) {
        super();
        this.deps = deps;
    }

    protected async _handle(_payload: GetCsrfTokenPayload): Promise<{ token: number }> {
        const cookies = await this.deps.ticketApi.getCookies(BKN_DOMAIN, this.deps.selfUin);
        const skey = cookies["skey"] ?? "";
        return { token: Number(TicketApi.getBkn(skey)) };
    }
}

const getCredentialsSchema = z.object({
    domain: z.string().optional(),
});

type GetCredentialsPayload = z.infer<typeof getCredentialsSchema>;

/** 获取凭据（cookies + csrf_token，P2-15）。 */
export class GetCredentialsAction extends BaseAction<
    GetCredentialsPayload,
    { cookies: Record<string, string>; csrf_token: number }
> {
    readonly name = "get_credentials";
    readonly schema = getCredentialsSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly deps: Pick<OneBotApi, "ticketApi" | "selfUin">;

    constructor(deps: Pick<OneBotApi, "ticketApi" | "selfUin">) {
        super();
        this.deps = deps;
    }

    protected async _handle(payload: GetCredentialsPayload): Promise<{
        cookies: Record<string, string>;
        csrf_token: number;
    }> {
        const domain = payload.domain ?? BKN_DOMAIN;
        const cookies = await this.deps.ticketApi.getCookies(domain, this.deps.selfUin);
        return {
            cookies,
            csrf_token: Number(TicketApi.getBkn(cookies["skey"] ?? "")),
        };
    }
}

const setSelfLongnickSchema = z.object({
    longNick: z.string(),
});

type SetSelfLongnickPayload = z.infer<typeof setSelfLongnickSchema>;

/** 设置个性签名（P2-14 接 kernel ProfileApi.setLongNick）。 */
export class SetSelfLongnickAction extends BaseAction<SetSelfLongnickPayload, null> {
    readonly name = "set_self_longnick";
    readonly schema = setSelfLongnickSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly profileApi: ProfileApi;

    constructor(profileApi: ProfileApi) {
        super();
        this.profileApi = profileApi;
    }

    protected async _handle(payload: SetSelfLongnickPayload): Promise<null> {
        await this.profileApi.setLongNick(payload.longNick);
        return null;
    }
}

const setQQProfileSchema = z.object({
    nickname: z.string(),
    personal_note: z.string().optional(),
    sex: z.union([z.number(), z.string()]).optional(),
});

type SetQQProfilePayload = z.infer<typeof setQQProfileSchema>;

/** 设置 QQ 资料（P2-14；nickname → setNickName，personal_note → setLongNick，sex 忽略）。 */
export class SetQQProfileAction extends BaseAction<SetQQProfilePayload, null> {
    readonly name = "set_qq_profile";
    readonly schema = setQQProfileSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly profileApi: ProfileApi;

    constructor(profileApi: ProfileApi) {
        super();
        this.profileApi = profileApi;
    }

    protected async _handle(payload: SetQQProfilePayload): Promise<null> {
        await this.profileApi.setNickName(payload.nickname);
        if (payload.personal_note !== undefined) {
            await this.profileApi.setLongNick(payload.personal_note);
        }
        return null;
    }
}

const setQQAvatarSchema = z.object({
    /** 本地路径（URL 需先下载，由装配方 cacheDir 支持）。 */
    file: z.string(),
});

type SetQQAvatarPayload = z.infer<typeof setQQAvatarSchema>;

/** 设置头像依赖（cacheDir 供 URL 下载，OneBotApi 视图）。 */
export type SetQQAvatarDeps = Pick<OneBotApi, "profileApi" | "cacheDir">;

/** 设置 QQ 头像（P2-14 接 kernel ProfileApi.setHeader）。 */
export class SetQQAvatarAction extends BaseAction<SetQQAvatarPayload, null> {
    readonly name = "set_qq_avatar";
    readonly schema = setQQAvatarSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly deps: SetQQAvatarDeps;

    constructor(deps: SetQQAvatarDeps) {
        super();
        this.deps = deps;
    }

    protected async _handle(payload: SetQQAvatarPayload): Promise<null> {
        let filePath = payload.file;
        if (URL_PREFIX.test(filePath)) {
            filePath = await this.downloadToCache(filePath);
        }
        if (!existsSync(filePath)) {
            throw kernelError(`头像文件不存在: ${filePath}`, "NOT_FOUND");
        }
        await this.deps.profileApi.setHeader(filePath);
        return null;
    }

    /** URL 下载到缓存目录（cacheDir 缺省抛错）。 */
    private async downloadToCache(url: string): Promise<string> {
        const { cacheDir } = this.deps;
        if (cacheDir === undefined || cacheDir === "") {
            throw kernelError(
                "set_qq_avatar 处理 URL 需要缓存目录（装配方未注入）",
                "INVALID_STATE",
            );
        }
        const safeName = basename(new URL(url).pathname) || "avatar.bin";
        const filePath = join(cacheDir, `avatar-${Date.now()}-${safeName}`);
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`头像下载失败: ${res.status} ${res.statusText}`);
        }
        const buf = new Uint8Array(await res.arrayBuffer());
        writeFileSync(filePath, buf);
        return filePath;
    }
}

/**
 * 账号票据与资料域动作工厂（cookies / clientkey / csrf_token / credentials /
 * self_longnick / qq_profile / qq_avatar）。
 */
export function createSystemAccountActions(api: OneBotApi): BaseAction<unknown, unknown>[] {
    return [
        new GetClientkeyAction(api.ticketApi),
        new GetCookiesAction(api),
        new GetCsrfTokenAction(api),
        new GetCredentialsAction(api),
        new SetSelfLongnickAction(api.profileApi),
        new SetQQProfileAction(api.profileApi),
        new SetQQAvatarAction(api),
    ];
}
