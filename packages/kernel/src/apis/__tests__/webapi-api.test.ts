/**
 * webapi.ts WebApi 类测试（parseHonorList 已有独立基线）：
 *  - getEssenceMsgList：分页拉取至 is_end / retcode 非 0 中断 / 非 200 中断 /
 *    fetch 抛错包装 KernelError / 分页参数与 Cookie 头
 *  - getGroupHonorInfo：ALL 拉全四类 / 单类型只拉对应类 / current_talkative 取首项 /
 *    honorlist 页面 __INITIAL_STATE__ 提取
 * global fetch 以 vi.stubGlobal 打桩——全程不触网。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { KernelError } from "../../infra/index.js";
import { TicketApi } from "../ticket.js";
import { WebApi, WebHonorType } from "../webapi.js";

const skey = "abc";
const bkn = TicketApi.getBkn(skey);
const cookie = { p_skey: "ps", skey };
const cookieHeader = "p_skey=ps; skey=abc";

function makeApi(): { api: WebApi; getCookies: ReturnType<typeof vi.fn> } {
    const getCookies = vi.fn(async () => cookie);
    return { api: new WebApi({ getCookies }), getCookies };
}

/** 构造 Response 桩（fetch 返回形态）。 */
function jsonResponse(body: unknown, ok = true): Response {
    return {
        ok,
        json: async () => body,
        text: async () => JSON.stringify(body),
    } as unknown as Response;
}

function textResponse(text: string, ok = true): Response {
    return { ok, json: async () => ({}), text: async () => text } as unknown as Response;
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("getEssenceMsgList", () => {
    it("分页拉取：is_end=false 续页，is_end=true 停止；参数与 Cookie 头正确", async () => {
        const { api, getCookies } = makeApi();
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(
                jsonResponse({ retcode: 0, data: { msg_list: [{ msg_seq: 1 }], is_end: false } }),
            )
            .mockResolvedValueOnce(
                jsonResponse({ retcode: 0, data: { msg_list: [{ msg_seq: 2 }], is_end: true } }),
            );
        vi.stubGlobal("fetch", fetchMock);

        await expect(api.getEssenceMsgList("10001")).resolves.toEqual([
            { msg_seq: 1 },
            { msg_seq: 2 },
        ]);
        expect(getCookies).toHaveBeenCalledWith("qun.qq.com");
        expect(fetchMock).toHaveBeenCalledTimes(2);
        const [url0, init0] = fetchMock.mock.calls[0] as [
            string,
            { headers: Record<string, string> },
        ];
        expect(url0).toContain(`bkn=${bkn}`);
        expect(url0).toContain("page_start=0");
        expect(url0).toContain("page_limit=50");
        expect(url0).toContain("group_code=10001");
        expect(init0.headers["Cookie"]).toBe(cookieHeader);
        const [url1] = fetchMock.mock.calls[1] as [string];
        expect(url1).toContain("page_start=50");
    });

    it("retcode 非 0 → 该页视为失败立即中断（不再续页）", async () => {
        const { api } = makeApi();
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ retcode: 1 }, true));
        vi.stubGlobal("fetch", fetchMock);
        await expect(api.getEssenceMsgList("10001")).resolves.toEqual([]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("非 200 响应 → 该页视为失败立即中断（不再续页）", async () => {
        const { api } = makeApi();
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, false));
        vi.stubGlobal("fetch", fetchMock);
        await expect(api.getEssenceMsgList("10001")).resolves.toEqual([]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("msg_list 非数组 → items 空；null 项过滤", async () => {
        const { api } = makeApi();
        const fetchMock = vi.fn().mockResolvedValue(
            jsonResponse({
                retcode: 0,
                data: { msg_list: [null, { msg_seq: 9 }], is_end: true },
            }),
        );
        vi.stubGlobal("fetch", fetchMock);
        await expect(api.getEssenceMsgList("10001")).resolves.toEqual([{ msg_seq: 9 }]);
    });

    it("fetch 抛错 → KernelError UNKNOWN", async () => {
        const { api } = makeApi();
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                throw new Error("offline");
            }),
        );
        await expect(api.getEssenceMsgList("10001")).rejects.toMatchObject({
            code: "UNKNOWN",
            message: /qun.qq.com 请求失败/,
        });
    });
});

describe("getGroupHonorInfo", () => {
    it("ALL：四类各拉一页；current_talkative 取 talkative 首项", async () => {
        const { api } = makeApi();
        const fetchMock = vi.fn((url: string) => {
            if (url.includes("honorlist")) {
                const type = new URL(url).searchParams.get("type");
                const list =
                    type === "1" ? [{ uin: 100, name: "龙王" }] : [{ uin: 200, name: "火" }];
                return Promise.resolve(
                    textResponse(
                        `<script>window.__INITIAL_STATE__=${JSON.stringify(
                            type === "1" ? { talkativeList: list } : { actorList: list },
                        )};</script>`,
                    ),
                );
            }
            return Promise.resolve(jsonResponse({ retcode: 0, data: {} }));
        });
        vi.stubGlobal("fetch", fetchMock);

        const info = await api.getGroupHonorInfo("10001", WebHonorType.ALL);
        expect(info.group_id).toBe(10001);
        expect(info.current_talkative).toEqual({ uin: "100", name: "龙王", avatar: "", desc: "" });
        expect(info.talkative_list).toEqual([{ uin: "100", name: "龙王", avatar: "", desc: "" }]);
        expect(info.performer_list).toEqual([{ uin: "200", name: "火", avatar: "", desc: "" }]);
        expect(info.legend_list).toEqual([{ uin: "200", name: "火", avatar: "", desc: "" }]);
        expect(info.emotion_list).toEqual([{ uin: "200", name: "火", avatar: "", desc: "" }]);
        expect(info.strong_newbie_list).toEqual([]);
        const honorUrls = (fetchMock.mock.calls as [string][])
            .map(([u]) => u)
            .filter((u) => u.includes("honorlist"));
        expect(honorUrls).toHaveLength(4);
        expect(new URL(honorUrls[0] ?? "").searchParams.get("type")).toBe("1");
    });

    it("单类型（TALKATIVE）只拉一页；其余列表保持空", async () => {
        const { api } = makeApi();
        const fetchMock = vi.fn(() =>
            Promise.resolve(
                textResponse(
                    '<script>window.__INITIAL_STATE__={"talkativeList":[{"uin":1}]};</script>',
                ),
            ),
        );
        vi.stubGlobal("fetch", fetchMock);
        const info = await api.getGroupHonorInfo("10001", WebHonorType.TALKATIVE);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(info.talkative_list).toHaveLength(1);
        expect(info.performer_list).toEqual([]);
        expect(info.legend_list).toEqual([]);
        expect(info.emotion_list).toEqual([]);
    });

    it("honorlist 请求失败（非 200）→ 该类空列表不抛错", async () => {
        const { api } = makeApi();
        vi.stubGlobal(
            "fetch",
            vi.fn(() => Promise.resolve(textResponse("", false))),
        );
        const info = await api.getGroupHonorInfo("10001", WebHonorType.EMOTION);
        expect(info.emotion_list).toEqual([]);
        expect(info.current_talkative).toBeNull();
    });

    it("talkative 列表为空 → current_talkative 保持 null", async () => {
        const { api } = makeApi();
        vi.stubGlobal(
            "fetch",
            vi.fn(() =>
                Promise.resolve(
                    textResponse('<script>window.__INITIAL_STATE__={"talkativeList":[]};</script>'),
                ),
            ),
        );
        const info = await api.getGroupHonorInfo("10001", WebHonorType.TALKATIVE);
        expect(info.current_talkative).toBeNull();
    });
});

describe("Cookie 头拼接", () => {
    it("多键分号拼接（空 dict → 空串）", async () => {
        const { api } = makeApi();
        let seen = "";
        vi.stubGlobal(
            "fetch",
            vi.fn((_url: string, init: { headers: Record<string, string> }) => {
                seen = init.headers["Cookie"] ?? "";
                return Promise.resolve(jsonResponse({ retcode: 0, data: { is_end: true } }));
            }),
        );
        await api.getEssenceMsgList("10001");
        expect(seen).toBe("p_skey=ps; skey=abc");
    });
});

describe("KernelError 透传", () => {
    it("WebApi 是纯注入构造（getCookies 由 TicketApi 提供时错误原样上抛）", async () => {
        const api = new WebApi({
            getCookies: async () => {
                throw new KernelError("票据失效", "NOT_LOGIN");
            },
        });
        vi.stubGlobal(
            "fetch",
            vi.fn(() => {
                throw new Error("should not be called");
            }),
        );
        await expect(api.getEssenceMsgList("10001")).rejects.toMatchObject({ code: "NOT_LOGIN" });
    });
});

describe("缺省分支补充", () => {
    it("cookie 无 skey → bkn 以空串参与 URL 组装（get_essence 不崩）", async () => {
        const api = new WebApi({ getCookies: async () => ({ p_skey: "ps" }) });
        let seenUrl = "";
        vi.stubGlobal(
            "fetch",
            vi.fn((url: string) => {
                seenUrl = url;
                return Promise.resolve(jsonResponse({ retcode: 0, data: { is_end: true } }));
            }),
        );
        await expect(api.getEssenceMsgList("10001")).resolves.toEqual([]);
        expect(seenUrl).toContain(`bkn=${TicketApi.getBkn("")}`);
    });

    it("响应 JSON 无 retcode → 视为失败该页中断（?? -1 兜底）", async () => {
        const { api } = makeApi();
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(jsonResponse({ data: { msg_list: [{ msg_seq: 1 }] } })),
        );
        await expect(api.getEssenceMsgList("10001")).resolves.toEqual([]);
    });

    it("honorlist 请求抛错（fetch reject）→ UNKNOWN 包装", async () => {
        const { api } = makeApi();
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                throw "dns fail";
            }),
        );
        await expect(api.getGroupHonorInfo("10001", WebHonorType.TALKATIVE)).rejects.toMatchObject({
            code: "UNKNOWN",
            message: /qun.qq.com 请求失败: dns fail/,
        });
    });
});
