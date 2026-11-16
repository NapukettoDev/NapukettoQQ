/**
 * WebApi：群空间 web 接口（P2-15）
 *
 * qun.qq.com 群空间接口需 Cookie（p_skey/skey）+ bkn（skey 哈希）。
 * 复用 TicketApi.getCookies('qun.qq.com') 取 Cookie，TicketApi.getBkn 算 bkn。
 * 零 NapCat 代码：接口契约（URL/参数/返回形状）是 qun.qq.com 外部系统的事实，
 * 自研描述。
 */
import { errorMessage, kernelError } from "../infra/index.js";
import { TicketApi } from "./ticket.js";

/** 群空间域名（Cookie 归属）。 */
const QUN_DOMAIN = "qun.qq.com";

/** 精华消息页大小（分页拉取）。 */
const ESSENCE_PAGE_LIMIT = 50;

/** 精华消息最大分页数。 */
const ESSENCE_MAX_PAGES = 20;

/** 精华消息项（digest_list 返回 data.msg_list 成员，说明书参考）。 */
export interface EssenceMsgItem {
    msg_seq: number;
    msg_random: number;
    sender_uin: string;
    sender_nick: string;
    add_digest_uin: string;
    add_digest_nick: string;
    add_digest_time: number;
    msg_content: Array<{
        msg_type?: number;
        text?: string;
        image_url?: string;
    }>;
}

/** 群荣誉项（honorlist 返回列表项，说明书参考）。 */
export interface HonorListItem {
    uin: string;
    name: string;
    avatar: string;
    desc: string;
}

/** 群荣誉信息（getGroupHonorInfo 返回）。 */
export interface GroupHonorWebInfo {
    group_id: number;
    current_talkative: HonorListItem | null;
    talkative_list: HonorListItem[];
    performer_list: HonorListItem[];
    legend_list: HonorListItem[];
    emotion_list: HonorListItem[];
    strong_newbie_list: HonorListItem[];
}

/** 群荣誉类型（1=龙王 2=群聊之火 3=群聊炽热 6=快乐源泉）。 */
export const WebHonorType = {
    ALL: 0,
    TALKATIVE: 1,
    PERFORMER: 2,
    LEGEND: 3,
    EMOTION: 6,
} as const;
export type WebHonorType = (typeof WebHonorType)[keyof typeof WebHonorType];

/** 群空间 web API（Cookie 经 TicketApi 注入）。 */
export class WebApi {
    private readonly getCookies: (domain: string) => Promise<Record<string, string>>;

    constructor(opts: { getCookies: (domain: string) => Promise<Record<string, string>> }) {
        this.getCookies = opts.getCookies;
    }

    /** 拉取单页精华消息（失败/retcode 非 0 返回 null）。 */
    private async fetchEssencePage(
        groupCode: string,
        cookie: Record<string, string>,
        bkn: string,
        page: number,
    ): Promise<{ items: EssenceMsgItem[]; isEnd: boolean } | null> {
        const url =
            "https://qun.qq.com/cgi-bin/group_digest/digest_list?" +
            new URLSearchParams({
                bkn,
                page_start: String(page * ESSENCE_PAGE_LIMIT),
                page_limit: String(ESSENCE_PAGE_LIMIT),
                group_code: groupCode,
            }).toString();
        const ret = await fetchQunJson(url, cookie);
        if (ret === null || ret.retcode !== 0) {
            return null;
        }
        const list = ret.data?.msg_list;
        return {
            items: Array.isArray(list) ? list.filter((item) => item !== null) : [],
            isEnd: ret.data?.is_end === true,
        };
    }

    /** 获取群精华消息列表（get_essence_msg_list；分页拉取至 is_end）。 */
    async getEssenceMsgList(groupCode: string): Promise<EssenceMsgItem[]> {
        const cookie = await this.getCookies(QUN_DOMAIN);
        const bkn = TicketApi.getBkn(cookie["skey"] ?? "");
        const out: EssenceMsgItem[] = [];
        for (let page = 0; page < ESSENCE_MAX_PAGES; page += 1) {
            const result = await this.fetchEssencePage(groupCode, cookie, bkn, page);
            if (result === null) {
                break;
            }
            out.push(...result.items);
            if (result.isEnd) {
                break;
            }
        }
        return out;
    }

    /** 获取群荣誉信息（get_group_honor_info；type 0=全部）。 */
    async getGroupHonorInfo(groupCode: string, type: WebHonorType): Promise<GroupHonorWebInfo> {
        const cookie = await this.getCookies(QUN_DOMAIN);
        const result: GroupHonorWebInfo = {
            group_id: Number(groupCode),
            current_talkative: null,
            talkative_list: [],
            performer_list: [],
            legend_list: [],
            emotion_list: [],
            strong_newbie_list: [],
        };
        await this.fillHonorLists(result, groupCode, cookie, type);
        return result;
    }

    /** 按 type 填充荣誉列表（ALL 拉全部，单类型只拉对应类）。 */
    private async fillHonorLists(
        result: GroupHonorWebInfo,
        groupCode: string,
        cookie: Record<string, string>,
        type: WebHonorType,
    ): Promise<void> {
        for (const target of honorTargets(type)) {
            const list = await this.fetchHonorList(groupCode, cookie, target.kind);
            result[target.listKey] = list;
            if (target.kind === WebHonorType.TALKATIVE) {
                const [first] = list;
                if (first !== undefined) {
                    result.current_talkative = first;
                }
            }
        }
    }

    /** 拉取单类荣誉列表（honorlist 接口，正则提取 __INITIAL_STATE__）。 */
    private async fetchHonorList(
        groupCode: string,
        cookie: Record<string, string>,
        type: number,
    ): Promise<HonorListItem[]> {
        const url =
            "https://qun.qq.com/interactive/honorlist?" +
            new URLSearchParams({ gc: groupCode, type: String(type) }).toString();
        const text = await fetchQunText(url, cookie);
        if (text === null) {
            return [];
        }
        return parseHonorList(text, type);
    }
}

/** honorlist 页面 __INITIAL_STATE__ 提取。 */
const INITIAL_STATE_RE = /window\.__INITIAL_STATE__=(.*?);/;

/** 从 honorlist 页面提取 __INITIAL_STATE__ → 荣誉列表（解析失败返回空）。 */
export function parseHonorList(text: string, type: number): HonorListItem[] {
    const match = INITIAL_STATE_RE.exec(text);
    if (match === null || match[1] === undefined) {
        return [];
    }
    let state: { talkativeList?: unknown; actorList?: unknown };
    try {
        state = JSON.parse(match[1]);
    } catch {
        return [];
    }
    const raw = type === WebHonorType.TALKATIVE ? state.talkativeList : state.actorList;
    if (!Array.isArray(raw)) {
        return [];
    }
    const out: HonorListItem[] = [];
    for (const item of raw) {
        if (item !== null && typeof item === "object") {
            const obj = item as {
                uin?: unknown;
                name?: unknown;
                avatar?: unknown;
                desc?: unknown;
            };
            out.push({
                uin: String(obj.uin ?? ""),
                name: String(obj.name ?? ""),
                avatar: String(obj.avatar ?? ""),
                desc: String(obj.desc ?? ""),
            });
        }
    }
    return out;
}

/** 请求 qun.qq.com JSON 接口（带 Cookie；失败返回 null）。 */
async function fetchQunJson(
    url: string,
    cookie: Record<string, string>,
): Promise<{ retcode: number; data?: { msg_list?: EssenceMsgItem[]; is_end?: boolean } } | null> {
    try {
        const res = await fetch(url, { headers: { Cookie: cookieToString(cookie) } });
        if (!res.ok) {
            return null;
        }
        const json = (await res.json()) as {
            retcode?: number;
            data?: { msg_list?: unknown; is_end?: unknown };
        };
        return {
            retcode: json.retcode ?? -1,
            data: json.data as { msg_list?: EssenceMsgItem[]; is_end?: boolean },
        };
    } catch (err) {
        throw kernelError(`qun.qq.com 请求失败: ${errorMessage(err)}`, "UNKNOWN");
    }
}

/** 请求 qun.qq.com 文本接口（带 Cookie；失败返回 null）。 */
async function fetchQunText(url: string, cookie: Record<string, string>): Promise<string | null> {
    try {
        const res = await fetch(url, { headers: { Cookie: cookieToString(cookie) } });
        if (!res.ok) {
            return null;
        }
        return await res.text();
    } catch (err) {
        throw kernelError(`qun.qq.com 请求失败: ${errorMessage(err)}`, "UNKNOWN");
    }
}

/** Cookie dict → 头字符串。 */
function cookieToString(cookie: Record<string, string>): string {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(cookie)) {
        parts.push(`${key}=${value}`);
    }
    return parts.join("; ");
}

/** 荣誉类型 → 目标列表（ALL 拉全部，单类型只拉对应类）。 */
function honorTargets(type: WebHonorType): Array<{
    kind: WebHonorType;
    listKey: "talkative_list" | "performer_list" | "legend_list" | "emotion_list";
}> {
    const all = [
        { kind: WebHonorType.TALKATIVE, listKey: "talkative_list" },
        { kind: WebHonorType.PERFORMER, listKey: "performer_list" },
        { kind: WebHonorType.LEGEND, listKey: "legend_list" },
        { kind: WebHonorType.EMOTION, listKey: "emotion_list" },
    ] as const;
    if (type === WebHonorType.ALL) {
        return [...all];
    }
    return all.filter((target) => target.kind === type);
}
