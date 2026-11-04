/**
 * ticket.ts TicketApi 测试：
 *  - constructor 空校验
 *  - getClientKey：result 非 0 / clientKey 空串抛错；成功返回完整对象
 *  - getCookies：node:https mock（不访问外网）——jump URL 组装、set-cookie 解析、
 *    超时 / 请求错误分支
 *  - getBkn：skey 哈希已知值
 */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { kernelError } from "../../infra/index.js";
import { makeSession } from "../test-support.js";
import { TicketApi } from "../ticket.js";

// mock node:https：getCookies 走 jump 地址拿 set-cookie（fetch 会吞头），测试不触网
const httpsGet = vi.fn();
vi.mock("node:https", () => ({
    get: (...args: unknown[]) => httpsGet(...args),
}));

/** 构造 TicketApi（ticket service 桩）。 */
function makeApi(overrides: Record<string, unknown> = {}) {
    const service = {
        forceFetchClientKey: vi.fn(async () => ({
            result: 0,
            errMsg: "",
            clientKey: "key-1",
        })),
        ...overrides,
    };
    const api = new TicketApi(makeSession({ getTicketService: () => service }));
    return { api, service };
}

/** 构造 https 响应桩（IncomingMessage 形态：headers + resume + on('end')）。 */
function makeRes(
    setCookie?: string[],
): EventEmitter & { headers: Record<string, unknown>; resume(): void } {
    const res = new EventEmitter() as EventEmitter & {
        headers: Record<string, unknown>;
        resume(): void;
    };
    res.headers = setCookie === undefined ? {} : { "set-cookie": setCookie };
    res.resume = () => undefined;
    return res;
}

/** 构造 https 请求桩（ClientRequest 形态：setTimeout / destroy / on）。 */
function makeReq() {
    const req = new EventEmitter() as EventEmitter & {
        setTimeout(timeout: number, cb: () => void): unknown;
        destroy(): void;
    };
    let timeoutCb: (() => void) | undefined;
    req.setTimeout = vi.fn((_timeout: number, cb: () => void) => {
        timeoutCb = cb;
        return req;
    });
    req.destroy = vi.fn();
    return { req, fireTimeout: () => timeoutCb?.() };
}

describe("constructor", () => {
    it("getTicketService 空 / undefined → INVALID_STATE", () => {
        expect(() => new TicketApi(makeSession({ getTicketService: () => null }))).toThrow(
            /getTicketService\(\) 返回空/,
        );
        expect(() => new TicketApi(makeSession({ getTicketService: () => undefined }))).toThrow(
            /getTicketService\(\) 返回空/,
        );
    });
});

describe("getClientKey", () => {
    it("成功返回完整对象", async () => {
        const { api } = makeApi();
        await expect(api.getClientKey()).resolves.toMatchObject({ clientKey: "key-1" });
    });

    it("result 非 0 抛 UNKNOWN", async () => {
        const { api } = makeApi({
            forceFetchClientKey: vi.fn(async () => ({ result: 1, errMsg: "x", clientKey: "k" })),
        });
        await expect(api.getClientKey()).rejects.toMatchObject({
            message: /forceFetchClientKey 失败/,
        });
    });

    it("clientKey 空串抛 UNKNOWN（票据无效视同失败）", async () => {
        const { api } = makeApi({
            forceFetchClientKey: vi.fn(async () => ({ result: 0, errMsg: "", clientKey: "" })),
        });
        await expect(api.getClientKey()).rejects.toMatchObject({
            code: "UNKNOWN",
        });
    });
});

describe("getBkn", () => {
    it("已知值：单字符 / 两字符 / 空 skey", () => {
        // hash = 5381; hash = hash + (hash << 5) + code
        expect(TicketApi.getBkn("a")).toBe(String(5381 + 5381 * 32 + 97));
        expect(TicketApi.getBkn("ab")).toBe(
            String((5381 + 5381 * 32 + 97 + (5381 + 5381 * 32 + 97) * 32 + 98) & 0x7f_ff_ff_ff),
        );
        expect(TicketApi.getBkn("")).toBe("5381");
    });
});

describe("getCookies（https mock，不触网）", () => {
    it("jump URL 组装（clientuin/clientkey/u1/keyindex）+ set-cookie 解析", async () => {
        const { api } = makeApi();
        httpsGet.mockImplementation((_url: string, _opts: unknown, cb: (res: unknown) => void) => {
            const res = makeRes([
                "p_skey=abc123; Path=/; Domain=qq.com; HttpOnly",
                "uin=o10001; Path=/",
                "malformed-no-equals",
                "=empty-name",
                "name2=",
            ]);
            cb(res);
            // end 事件异步触发 resolve
            queueMicrotask(() => res.emit("end"));
            return makeReq().req;
        });
        await expect(api.getCookies("qun.qq.com", "10001")).resolves.toEqual({
            p_skey: "abc123",
            uin: "o10001",
            name2: "",
        });
        const [url, opts] = httpsGet.mock.calls[0] as [string, Record<string, unknown>];
        expect(url).toBe(
            "https://ssl.ptlogin2.qq.com/jump?ptlang=1033" +
                "&clientuin=10001" +
                `&clientkey=${encodeURIComponent("key-1")}` +
                `&u1=${encodeURIComponent("https://qun.qq.com/10001/infocenter")}` +
                "&keyindex=19",
        );
        expect(opts["headers"]).toMatchObject({
            "user-agent": expect.stringContaining("Mozilla/5.0"),
        });
    });

    it("无 set-cookie 头 → 空 cookie dict", async () => {
        const { api } = makeApi();
        httpsGet.mockImplementation((_url: string, _opts: unknown, cb: (res: unknown) => void) => {
            const res = makeRes();
            cb(res);
            queueMicrotask(() => res.emit("end"));
            return makeReq().req;
        });
        await expect(api.getCookies("qun.qq.com", "10001")).resolves.toEqual({});
    });

    it("请求错误 → 原样 reject", async () => {
        const { api } = makeApi();
        httpsGet.mockImplementation(() => {
            const { req } = makeReq();
            queueMicrotask(() => req.emit("error", new Error("ECONNREFUSED")));
            return req;
        });
        await expect(api.getCookies("qun.qq.com", "10001")).rejects.toThrow(/ECONNREFUSED/);
    });

    it("超时 → destroy + 「获取 cookies 超时」reject", async () => {
        const { api } = makeApi();
        httpsGet.mockImplementation(() => {
            const { req, fireTimeout } = makeReq();
            queueMicrotask(() => fireTimeout());
            return req;
        });
        await expect(api.getCookies("qun.qq.com", "10001")).rejects.toThrow(/获取 cookies 超时/);
    });

    it("clientKey 失败时 getCookies 直接抛错（不发 https）", async () => {
        const { api } = makeApi({
            forceFetchClientKey: vi.fn(async () => {
                throw kernelError("票据失效", "NOT_LOGIN");
            }),
        });
        await expect(api.getCookies("qun.qq.com", "10001")).rejects.toMatchObject({
            code: "NOT_LOGIN",
        });
        expect(httpsGet).not.toHaveBeenCalled();
    });
});

describe("set-cookie 边界形态", () => {
    it("等号前空白（名称裁剪为空）→ 跳过该 cookie", async () => {
        const { api } = makeApi();
        httpsGet.mockImplementation((_url: string, _opts: unknown, cb: (res: unknown) => void) => {
            const res = makeRes(["p_skey=ps; Path=/", "   =orphan"]);
            cb(res);
            queueMicrotask(() => res.emit("end"));
            return makeReq().req;
        });
        await expect(api.getCookies("qun.qq.com", "10001")).resolves.toEqual({
            p_skey: "ps",
        });
    });
});
