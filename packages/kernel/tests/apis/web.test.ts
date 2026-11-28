import { once } from "node:events";
import { createServer, type RequestListener, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TicketApi } from "../../src/apis/ticket.js";
import { WebApi, WebHonorType } from "../../src/apis/web.js";

const nativeFetch = globalThis.fetch;
const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
const servers: Server[] = [];

afterEach(async () => {
    vi.restoreAllMocks();
    for (const server of servers.splice(0)) {
        const closed = once(server, "close");
        server.close();
        server.closeAllConnections();
        await closed;
    }
});

async function serve(handler: RequestListener) {
    const server = createServer(handler);
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("未取得环回端口");
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
        const url = new URL(String(input));
        expect(url.host).toBe("qun.qq.com");
        return nativeFetch(`http://127.0.0.1:${addr.port}${url.pathname}${url.search}`, init);
    });
    const api = new WebApi({
        getCookies: async (domain) => {
            expect(domain).toBe("qun.qq.com");
            return { skey: "test-skey", p_skey: "test-cookie" };
        },
    });
    return { api, fetch };
}

describe("群空间 WebApi HTTP 生命周期", () => {
    it("按原 Cookie、bkn、参数解析两页精华及荣誉 HTML", async () => {
        const item = { msg_seq: 1, msg_content: [{ text: "测试" }] };
        const pages: string[] = [];
        const { api, fetch } = await serve((req, res) => {
            const url = new URL(req.url ?? "/", "http://localhost");
            expect(req.headers.cookie).toBe("skey=test-skey; p_skey=test-cookie");
            if (url.pathname.endsWith("/digest_list")) {
                expect(url.searchParams.get("bkn")).toBe(TicketApi.getBkn("test-skey"));
                expect(url.searchParams.get("group_code")).toBe("123");
                expect(url.searchParams.get("page_limit")).toBe("50");
                const offset = url.searchParams.get("page_start") ?? "";
                pages.push(offset);
                res.end(
                    JSON.stringify({
                        retcode: 0,
                        data: { msg_list: [item], is_end: offset === "50" },
                    }),
                );
                return;
            }
            expect(url.search).toBe("?gc=123&type=1");
            res.end(
                '<script>window.__INITIAL_STATE__={"talkativeList":[{"uin":123,"name":"测试"}]};</script>',
            );
        });
        expect(await api.getEssenceMsgList("123")).toEqual([item, item]);
        expect(pages).toEqual(["0", "50"]);
        expect(fetch.mock.calls[0]?.[1]?.signal).toBe(fetch.mock.calls[1]?.[1]?.signal);
        expect(await api.getGroupHonorInfo("123", WebHonorType.TALKATIVE)).toMatchObject({
            group_id: 123,
            current_talkative: { uin: "123", name: "测试" },
        });
    });

    it("非成功分页取消持续正文并返回已读精华", async () => {
        const closed = Promise.withResolvers<void>();
        const item = { msg_seq: 1, msg_content: [] };
        const { api } = await serve((req, res) => {
            if (req.url?.includes("page_start=0")) {
                res.end(JSON.stringify({ retcode: 0, data: { msg_list: [item] } }));
                return;
            }
            res.once("close", closed.resolve);
            res.writeHead(503).write("still streaming");
        });
        expect(await api.getEssenceMsgList("123")).toEqual([item]);
        await closed.promise;
    });

    it.each([false, true])("超时回收慢响应，已发响应头=%s", async (sendHeaders) => {
        const closed = Promise.withResolvers<void>();
        const timeout = vi
            .spyOn(AbortSignal, "timeout")
            .mockImplementation(() => nativeTimeout(400));
        const { api } = await serve((_req, res) => {
            res.once("close", closed.resolve);
            if (sendHeaders) res.writeHead(200).write("<html>");
        });
        await expect(api.getGroupHonorInfo("123", WebHonorType.TALKATIVE)).rejects.toMatchObject({
            code: "TIMEOUT",
        });
        expect(timeout).toHaveBeenCalledWith(10_000);
        await closed.promise;
    });

    it("调用方取消后释放在途正文", async () => {
        const entered = Promise.withResolvers<void>();
        const closed = Promise.withResolvers<void>();
        const { api, fetch } = await serve((_req, res) => {
            res.once("close", closed.resolve);
            res.writeHead(200).write('{"retcode":');
            entered.resolve();
        });
        const controller = new AbortController();
        const request = api.getEssenceMsgList("123", controller.signal);
        const cancelled = expect(request).rejects.toMatchObject({
            code: "UNKNOWN",
            message: expect.stringContaining("取消"),
        });
        await entered.promise;
        const result = fetch.mock.results[0];
        if (result?.type !== "return") throw new Error("未发起群空间请求");
        await result.value;
        controller.abort();
        await cancelled;
        await closed.promise;
    });

    it("流式正文超过 4 MiB 时停止读取并释放连接", async () => {
        const closed = Promise.withResolvers<void>();
        const { api } = await serve((_req, res) => {
            res.once("close", closed.resolve);
            res.writeHead(200).write(Buffer.alloc(4 * 1024 * 1024 + 1, 0x20));
        });
        await expect(api.getEssenceMsgList("123")).rejects.toMatchObject({
            code: "UNKNOWN",
            message: expect.stringContaining("正文超限"),
        });
        await closed.promise;
    });

    it("非对象 JSON 保留 INVALID_PARAM", async () => {
        const { api } = await serve((_req, res) => res.end("[]"));
        await expect(api.getEssenceMsgList("123")).rejects.toMatchObject({ code: "INVALID_PARAM" });
    });
});
