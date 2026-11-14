/**
 * 票据动作测试：get_clientkey / get_cookies / get_csrf_token / get_credentials。
 *
 * 锁定行为：TicketApi 调用参数（domain 缺省值、user_id 覆盖 selfUin）、
 * skey → bkn 计算（TicketApi.getBkn）、clientKey 原样映射。
 */
import { TicketApi } from "@napuketto/kernel";
import { describe, expect, it, vi } from "vitest";
import { ob11ActionOf } from "../../__tests__/test-support.js";
import { createSystemAccountActions } from "../account.js";

/** 构造 ticket 依赖（selfUin=10001）。 */
function ticketDeps(cookies: Record<string, string> = { skey: "@testSkey" }) {
    return {
        ticketApi: { getCookies: vi.fn(async () => cookies) },
        selfUin: "10001",
    };
}

describe("get_clientkey", () => {
    it("getClientKey → 四字段原样映射", async () => {
        const ticketApi = {
            getClientKey: vi.fn(async () => ({
                clientKey: "ck",
                keyIndex: "1",
                expireTime: "1700000000",
                url: "https://example",
            })),
        };
        const result = await ob11ActionOf(
            createSystemAccountActions({ ticketApi } as never),
            "get_clientkey",
        ).handle({});
        expect(result.data).toEqual({
            clientKey: "ck",
            keyIndex: "1",
            expireTime: "1700000000",
            url: "https://example",
        });
    });
});

describe("get_cookies", () => {
    it("domain/user_id 缺省 → v2.qq.com + selfUin", async () => {
        const deps = ticketDeps();
        const result = await ob11ActionOf(
            createSystemAccountActions(deps as never),
            "get_cookies",
        ).handle({});
        expect(result.data).toEqual({ skey: "@testSkey" });
        expect(deps.ticketApi.getCookies).toHaveBeenCalledWith("v2.qq.com", "10001");
    });

    it("domain/user_id 显式传入覆盖", async () => {
        const deps = ticketDeps();
        await ob11ActionOf(createSystemAccountActions(deps as never), "get_cookies").handle({
            domain: "qun.qq.com",
            user_id: 90001,
        });
        expect(deps.ticketApi.getCookies).toHaveBeenCalledWith("qun.qq.com", "90001");
    });
});

describe("get_csrf_token", () => {
    it("qun.qq.com skey → bkn 数值", async () => {
        const deps = ticketDeps({ skey: "@abc" });
        const result = await ob11ActionOf<{ token: number }>(
            createSystemAccountActions(deps as never),
            "get_csrf_token",
        ).handle({});
        expect(result.status).toBe("ok");
        expect(deps.ticketApi.getCookies).toHaveBeenCalledWith("qun.qq.com", "10001");
        expect(result.data?.token).toBe(Number(TicketApi.getBkn("@abc")));
    });

    it('skey 缺失 → 空 bkn（getBkn("") 初值）', async () => {
        const deps = ticketDeps({});
        const result = await ob11ActionOf<{ token: number }>(
            createSystemAccountActions(deps as never),
            "get_csrf_token",
        ).handle({});
        expect(result.data?.token).toBe(Number(TicketApi.getBkn("")));
    });
});

describe("get_credentials", () => {
    it("domain 缺省 qun.qq.com → cookies + csrf_token", async () => {
        const deps = ticketDeps({ skey: "@abc" });
        const result = await ob11ActionOf(
            createSystemAccountActions(deps as never),
            "get_credentials",
        ).handle({});
        expect(result.data).toEqual({
            cookies: { skey: "@abc" },
            csrf_token: Number(TicketApi.getBkn("@abc")),
        });
        expect(deps.ticketApi.getCookies).toHaveBeenCalledWith("qun.qq.com", "10001");
    });

    it("cookies 无 skey → csrf_token 取 getBkn 空串初值", async () => {
        const deps = ticketDeps({});
        const result = await ob11ActionOf<{ cookies: Record<string, string>; csrf_token: number }>(
            createSystemAccountActions(deps as never),
            "get_credentials",
        ).handle({});
        expect(result.data?.cookies).toEqual({});
        expect(result.data?.csrf_token).toBe(Number(TicketApi.getBkn("")));
    });

    it("自定义 domain 透传", async () => {
        const deps = ticketDeps();
        await ob11ActionOf(createSystemAccountActions(deps as never), "get_credentials").handle({
            domain: "vip.qq.com",
        });
        expect(deps.ticketApi.getCookies).toHaveBeenCalledWith("vip.qq.com", "10001");
    });
});
