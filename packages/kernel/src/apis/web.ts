/**
 * WebApi：qun.qq.com 群空间 web 接口，需 Cookie（p_skey/skey）+ bkn（skey 哈希）。
 * Cookie 经 TicketApi.getCookies('qun.qq.com') 获取，bkn 由 TicketApi.getBkn 计算。
 * 接口契约（URL/参数/返回形状）是 qun.qq.com 外部系统的事实，自研描述。
 */
import { errorMessage, isKernelError, kernelError } from "../infra/index.js";
import { hasNullableNumberProp, hasNullableStringProp, isRecord } from "../infra/type-guards.js";
import { TicketApi } from "./ticket.js";

/** 群空间域名（Cookie 归属）。 */
const QUN_DOMAIN = "qun.qq.com";

/** 精华消息页大小（分页拉取）。 */
const ESSENCE_PAGE_LIMIT = 50;

/** 精华消息最大分页数。 */
const ESSENCE_MAX_PAGES = 20;

const QUN_REQUEST_TIMEOUT_MS = 10_000;
const QUN_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

interface QunRequest {
    cookie: Record<string, string>;
    signal: AbortSignal;
}

/** 精华消息项（digest_list 返回 data.msg_list 成员，说明书参考）。
 * 原生返回并不保证带全部展示字段，缺失按 optional 防御；`msg_content` 是标识字段。 */
export interface EssenceMsgItem {
    msg_seq?: number;
    msg_random?: number;
    sender_uin?: string;
    sender_nick?: string;
    add_digest_uin?: string;
    add_digest_nick?: string;
    add_digest_time?: number;
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
        request: QunRequest,
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
        const ret = await fetchQunJson(url, request);
        if (ret === null || ret.retcode !== 0) {
            return null;
        }
        return { items: extractEssenceItems(ret.msgList), isEnd: ret.isEnd };
    }

    /** 获取群精华消息列表（get_essence_msg_list；分页拉取至 is_end）。 */
    async getEssenceMsgList(groupCode: string, signal?: AbortSignal): Promise<EssenceMsgItem[]> {
        const request = await this.createRequest(signal);
        const bkn = TicketApi.getBkn(request.cookie["skey"] ?? "");
        const out: EssenceMsgItem[] = [];
        for (let page = 0; page < ESSENCE_MAX_PAGES; page += 1) {
            const result = await this.fetchEssencePage(groupCode, request, bkn, page);
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
    async getGroupHonorInfo(
        groupCode: string,
        type: WebHonorType,
        signal?: AbortSignal,
    ): Promise<GroupHonorWebInfo> {
        const request = await this.createRequest(signal);
        const result: GroupHonorWebInfo = {
            group_id: Number(groupCode),
            current_talkative: null,
            talkative_list: [],
            performer_list: [],
            legend_list: [],
            emotion_list: [],
            strong_newbie_list: [],
        };
        await this.fillHonorLists(result, groupCode, request, type);
        return result;
    }

    private async createRequest(signal: AbortSignal | undefined): Promise<QunRequest> {
        checkQunCancellation(signal);
        const cookie = await this.getCookies(QUN_DOMAIN);
        checkQunCancellation(signal);
        const timeout = AbortSignal.timeout(QUN_REQUEST_TIMEOUT_MS);
        return { cookie, signal: signal ? AbortSignal.any([signal, timeout]) : timeout };
    }

    /** 按 type 填充荣誉列表（ALL 拉全部，单类型只拉对应类）。 */
    private async fillHonorLists(
        result: GroupHonorWebInfo,
        groupCode: string,
        request: QunRequest,
        type: WebHonorType,
    ): Promise<void> {
        for (const target of honorTargets(type)) {
            const list = await this.fetchHonorList(groupCode, request, target.kind);
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
        request: QunRequest,
        type: number,
    ): Promise<HonorListItem[]> {
        const url =
            "https://qun.qq.com/interactive/honorlist?" +
            new URLSearchParams({ gc: groupCode, type: String(type) }).toString();
        const text = await fetchQunText(url, request);
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
    let state: unknown;
    try {
        state = JSON.parse(match[1]);
    } catch {
        return [];
    }
    if (!isRecord(state)) {
        return [];
    }
    const raw = type === WebHonorType.TALKATIVE ? state["talkativeList"] : state["actorList"];
    if (!Array.isArray(raw)) {
        return [];
    }
    const out: HonorListItem[] = [];
    for (const item of raw) {
        if (!isRecord(item)) {
            continue;
        }
        out.push({
            uin: String(item["uin"] ?? ""),
            name: String(item["name"] ?? ""),
            avatar: String(item["avatar"] ?? ""),
            desc: String(item["desc"] ?? ""),
        });
    }
    return out;
}

/** 精华消息项形状判定（msg_content 数组必备；其余字段存在时逐一校验类型）。 */
function isEssenceMsgItem(val: unknown): val is EssenceMsgItem {
    return (
        isRecord(val) &&
        Array.isArray(val["msg_content"]) &&
        hasNullableStringProp(val, "sender_uin") &&
        hasNullableStringProp(val, "sender_nick") &&
        hasNullableStringProp(val, "add_digest_uin") &&
        hasNullableStringProp(val, "add_digest_nick") &&
        hasNullableNumberProp(val, "msg_seq") &&
        hasNullableNumberProp(val, "msg_random") &&
        hasNullableNumberProp(val, "add_digest_time")
    );
}

/** msg_list → 精华消息数组（逐项守卫，非数组 / 残缺项丢弃）。 */
function extractEssenceItems(list: unknown): EssenceMsgItem[] {
    return Array.isArray(list) ? list.filter(isEssenceMsgItem) : [];
}

/** qun.qq.com JSON 响应（收窄后的形状；msgList / isEnd 已经过对象校验）。 */
interface QunJsonResponse {
    retcode: number;
    msgList: unknown;
    isEnd: boolean;
}

/**
 * 请求 qun.qq.com JSON 接口（带 Cookie；失败返回 null）。
 * 响应体先过 `isRecord` 收窄再取字段——非对象 JSON（数组 / 标量）按 INVALID_PARAM 抛出。
 */
async function fetchQunJson(url: string, request: QunRequest): Promise<QunJsonResponse | null> {
    const text = await fetchQunText(url, request);
    if (text === null) return null;
    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch (err) {
        throw kernelError(`qun.qq.com 请求失败: ${errorMessage(err)}`, "UNKNOWN");
    }
    if (!isRecord(json)) {
        throw kernelError("群 WebApi 响应非 JSON 对象", "INVALID_PARAM");
    }
    const data = json["data"];
    return {
        retcode: typeof json["retcode"] === "number" ? json["retcode"] : -1,
        msgList: isRecord(data) ? data["msg_list"] : undefined,
        isEnd: isRecord(data) && data["is_end"] === true,
    };
}

function checkQunCancellation(signal: AbortSignal | undefined): void {
    if (!signal?.aborted) return;
    if (signal.reason instanceof DOMException && signal.reason.name === "TimeoutError") {
        throw kernelError("qun.qq.com 请求超时", "TIMEOUT");
    }
    throw kernelError("qun.qq.com 请求已取消", "UNKNOWN");
}

/** 群空间的非成功响应仍按空页处理。 */
async function fetchQunText(url: string, { cookie, signal }: QunRequest): Promise<string | null> {
    try {
        checkQunCancellation(signal);
        const res = await fetch(url, { headers: { Cookie: cookieToString(cookie) }, signal });
        if (!res.ok) {
            // 正文可能已被中止或失效，HTTP 状态仍足以决定降级行为。
            await res.body?.cancel().catch(() => checkQunCancellation(signal));
            return null;
        }
        return await readQunText(res.body);
    } catch (err) {
        checkQunCancellation(signal);
        if (isKernelError(err)) throw err;
        throw kernelError(`qun.qq.com 请求失败: ${errorMessage(err)}`, "UNKNOWN");
    }
}

async function readQunText(body: Response["body"]): Promise<string> {
    if (!body) return "";
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const parts: string[] = [];
    let bytes = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > QUN_MAX_RESPONSE_BYTES) {
                // 停止底层传输，即使远端还在发送正文。
                await reader.cancel().catch(() => undefined);
                throw kernelError("qun.qq.com 响应正文超限", "UNKNOWN");
            }
            parts.push(decoder.decode(value, { stream: true }));
        }
        parts.push(decoder.decode());
        return parts.join("");
    } finally {
        reader.releaseLock();
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
