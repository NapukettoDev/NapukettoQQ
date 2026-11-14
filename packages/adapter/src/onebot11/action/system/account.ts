/**
 * 账号票据与资料域动作
 *
 * - get_cookies：kernel TicketApi.getCookies，domain 缺省 v2.qq.com
 *   （NapCat 行为）；user_id 缺省用机器人自身 uin
 * - get_clientkey：kernel TicketApi.getClientKey
 * - get_csrf_token / get_credentials：qun.qq.com cookies 的 skey → bkn
 *   （csrf 等价物）；get_credentials 返回指定域名 cookies + bkn
 * - set_self_longnick / set_qq_profile / set_qq_avatar：kernel ProfileApi；
 *   set_qq_profile 的 sex 忽略，头像 URL 需先经 cacheDir 下载
 */

import { existsSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { kernelError, TicketApi } from "@napuketto/kernel";
import { z } from "zod";
import type { OneBotApi } from "../../api/one-bot-api.js";
import { defineOb11Action, type Ob11Action } from "../base-action.js";

/** URL 前缀（头像在线文件识别）。 */
const URL_PREFIX = /^https?:\/\//;

/** 默认域名。 */
const DEFAULT_DOMAIN = "v2.qq.com";

/** 默认域名（bkn 计算用）。 */
const BKN_DOMAIN = "qun.qq.com";

const getCookiesSchema = z.object({
    domain: z.string().optional(),
    user_id: z.number().optional(),
});

const getClientkeySchema = z.object({});

const getCsrfTokenSchema = z.object({});

const getCredentialsSchema = z.object({
    domain: z.string().optional(),
});

const setSelfLongnickSchema = z.object({
    longNick: z.string(),
});

const setQQProfileSchema = z.object({
    nickname: z.string(),
    personal_note: z.string().optional(),
    sex: z.union([z.number(), z.string()]).optional(),
});

const setQQAvatarSchema = z.object({
    /** 本地路径（URL 需先下载，由装配方 cacheDir 支持）。 */
    file: z.string(),
});

/** URL 头像下载到缓存目录（cacheDir 缺省抛错）。 */
async function downloadAvatarToCache(url: string, cacheDir: string | undefined): Promise<string> {
    if (cacheDir === undefined || cacheDir === "") {
        throw kernelError("set_qq_avatar 处理 URL 需要缓存目录（装配方未注入）", "INVALID_STATE");
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

/**
 * 账号票据与资料域动作工厂（cookies / clientkey / csrf_token / credentials /
 * self_longnick / qq_profile / qq_avatar）。
 */
export function createSystemAccountActions(api: OneBotApi): Ob11Action[] {
    return [
        defineOb11Action({
            name: "get_clientkey",
            schema: getClientkeySchema,
            handle: async () => {
                const raw = await api.ticketApi.getClientKey();
                return {
                    clientKey: raw.clientKey,
                    keyIndex: raw.keyIndex,
                    expireTime: raw.expireTime,
                    url: raw.url,
                };
            },
        }),
        defineOb11Action({
            name: "get_cookies",
            schema: getCookiesSchema,
            handle: (payload): Promise<Record<string, string>> => {
                const domain = payload.domain ?? DEFAULT_DOMAIN;
                let uin = api.selfUin;
                if (payload.user_id !== undefined) {
                    uin = String(payload.user_id);
                }
                return api.ticketApi.getCookies(domain, uin);
            },
        }),
        defineOb11Action({
            name: "get_csrf_token",
            schema: getCsrfTokenSchema,
            handle: async () => {
                const cookies = await api.ticketApi.getCookies(BKN_DOMAIN, api.selfUin);
                const skey = cookies["skey"] ?? "";
                return { token: Number(TicketApi.getBkn(skey)) };
            },
        }),
        defineOb11Action({
            name: "get_credentials",
            schema: getCredentialsSchema,
            handle: async (payload) => {
                const domain = payload.domain ?? BKN_DOMAIN;
                const cookies = await api.ticketApi.getCookies(domain, api.selfUin);
                return {
                    cookies,
                    csrf_token: Number(TicketApi.getBkn(cookies["skey"] ?? "")),
                };
            },
        }),
        defineOb11Action({
            name: "set_self_longnick",
            schema: setSelfLongnickSchema,
            handle: async (payload) => {
                await api.profileApi.setLongNick(payload.longNick);
                return null;
            },
        }),
        defineOb11Action({
            name: "set_qq_profile",
            schema: setQQProfileSchema,
            handle: async (payload) => {
                await api.profileApi.setNickName(payload.nickname);
                if (payload.personal_note !== undefined) {
                    await api.profileApi.setLongNick(payload.personal_note);
                }
                return null;
            },
        }),
        defineOb11Action({
            name: "set_qq_avatar",
            schema: setQQAvatarSchema,
            handle: async (payload) => {
                let filePath = payload.file;
                if (URL_PREFIX.test(filePath)) {
                    filePath = await downloadAvatarToCache(filePath, api.cacheDir);
                }
                if (!existsSync(filePath)) {
                    throw kernelError(`头像文件不存在: ${filePath}`, "NOT_FOUND");
                }
                await api.profileApi.setHeader(filePath);
                return null;
            },
        }),
    ];
}
