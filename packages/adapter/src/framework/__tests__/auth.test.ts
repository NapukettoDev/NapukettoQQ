/**
 * core/framework/auth.test.ts：协议层 Token 鉴权原语单测。
 *
 * 锁定参数化后的三协议方言：
 *  - createTokenAuthorize 在 token 为 undefined / "" 时不装钩子；
 *  - Bearer 头（authorization / Authorization 两种头名）匹配与拒绝；
 *  - allowRawHeader 开启 OB11 裸头兼容；关闭时裸头与「错误 Bearer + 查询参数」
 *    都拒绝（Milky 语义）；
 *  - allowQueryToken 以 dummy base 解析相对路径 ?access_token=；非法 URL
 *    fail-closed 并触发 onQueryParseError 留痕。
 */
import { timingSafeEqual } from "node:crypto";
import type { RequestContext } from "@napuketto/network";
import { describe, expect, it, vi } from "vitest";
import { BEARER_PREFIX, createTokenAuthorize, matchTokenCredential, tokenEquals } from "../auth.js";

// 调用真实 crypto 实现，验证比较原语的安全前置条件；不使用不稳定的耗时断言。
vi.mock("node:crypto", async (importOriginal) => {
    const crypto = await importOriginal<typeof import("node:crypto")>();
    return { ...crypto, timingSafeEqual: vi.fn(crypto.timingSafeEqual) };
});

const TOKEN = "secret-token";

/** 构造请求上下文（url 显式给出，headers 按方言覆盖）。 */
function makeCtx(url: string, headers: Record<string, string | undefined> = {}): RequestContext {
    return { url, headers };
}

/** 带 Bearer 头的上下文（头名可切换大小写）。 */
function bearerCtx(value: string, headerName = "authorization"): RequestContext {
    return makeCtx("/", { [headerName]: `${BEARER_PREFIX}${value}` });
}

describe("createTokenAuthorize", () => {
    it("token 为 undefined / 空串 → 返回 undefined（装配方不挂鉴权钩子）", () => {
        expect(createTokenAuthorize(undefined)).toBeUndefined();
        expect(createTokenAuthorize("")).toBeUndefined();
    });

    it("token 非空 → 返回钩子并复用方言开关", () => {
        const authorize = createTokenAuthorize(TOKEN, { allowQueryToken: true });
        expect(authorize).toBeTypeOf("function");
        expect(authorize?.(bearerCtx(TOKEN))).toBe(true);
        expect(authorize?.(makeCtx(`/ws?access_token=${TOKEN}`))).toBe(true);
        expect(authorize?.(makeCtx("/ws"))).toBe(false);
    });
});

describe("matchTokenCredential：Bearer 头", () => {
    it("小写 authorization 头匹配", () => {
        expect(matchTokenCredential(bearerCtx(TOKEN), TOKEN)).toBe(true);
    });

    it("大写 Authorization 头匹配（头名兜底）", () => {
        expect(matchTokenCredential(bearerCtx(TOKEN, "Authorization"), TOKEN)).toBe(true);
    });

    it("Bearer 值错误 / 前缀不对 / 无头 → 拒绝", () => {
        expect(matchTokenCredential(bearerCtx("wrong"), TOKEN)).toBe(false);
        expect(matchTokenCredential(bearerCtx(`${TOKEN}-extra`), TOKEN)).toBe(false);
        expect(matchTokenCredential(makeCtx("/", { authorization: `Basic ${TOKEN}` }), TOKEN)).toBe(
            false,
        );
        expect(matchTokenCredential(makeCtx("/"), TOKEN)).toBe(false);
    });
});

describe("matchTokenCredential：allowRawHeader（OB11 裸头）", () => {
    it("Authorization 与 authorization 裸头一致，小写头存在时仍优先", () => {
        expect(
            matchTokenCredential(makeCtx("/", { ["Authorization"]: TOKEN }), TOKEN, {
                allowRawHeader: true,
            }),
        ).toBe(true);
        expect(
            matchTokenCredential(
                makeCtx("/", {
                    authorization: "wrong",
                    ["Authorization"]: TOKEN,
                }),
                TOKEN,
                { allowRawHeader: true },
            ),
        ).toBe(false);
    });
    it("开启后裸 authorization 头等于 token 即通过", () => {
        const ctx = makeCtx("/", { authorization: TOKEN });
        expect(matchTokenCredential(ctx, TOKEN, { allowRawHeader: true })).toBe(true);
        expect(matchTokenCredential(ctx, TOKEN)).toBe(false);
    });

    it("显式 false 时裸头不通过", () => {
        const ctx = makeCtx("/", { authorization: TOKEN });
        expect(matchTokenCredential(ctx, TOKEN, { allowRawHeader: false })).toBe(false);
    });

    it("错误 Bearer + allowRawHeader → 仍可被 ?access_token= 兜底（OB11 语义）", () => {
        const ctx = makeCtx(`/ws?access_token=${TOKEN}`, { authorization: `Bearer wrong` });
        expect(
            matchTokenCredential(ctx, TOKEN, { allowQueryToken: true, allowRawHeader: true }),
        ).toBe(true);
    });

    it("错误 Bearer 且未开 allowRawHeader → 立即拒绝，不再看查询参数（Milky 语义）", () => {
        const ctx = makeCtx(`/ws?access_token=${TOKEN}`, { authorization: `Bearer wrong` });
        expect(matchTokenCredential(ctx, TOKEN, { allowQueryToken: true })).toBe(false);
    });
});

describe("鉴权比较边界", () => {
    it("所有凭据入口向恒定时间原语传入相同固定长度的摘要，包括不同长度输入", () => {
        const compare = vi.mocked(timingSafeEqual);
        compare.mockClear();
        expect(matchTokenCredential(bearerCtx(TOKEN), TOKEN)).toBe(true);
        expect(matchTokenCredential(bearerCtx("x"), TOKEN)).toBe(false);
        expect(
            matchTokenCredential(makeCtx("/", { ["Authorization"]: TOKEN }), TOKEN, {
                allowRawHeader: true,
            }),
        ).toBe(true);
        expect(
            matchTokenCredential(makeCtx(`/?access_token=${TOKEN}`), TOKEN, {
                allowQueryToken: true,
            }),
        ).toBe(true);
        expect(tokenEquals("虚构令牌🔑", "虚构令牌🔑")).toBe(true);
        expect(compare).toHaveBeenCalledTimes(5);
        for (const [actual, expected] of compare.mock.calls) {
            expect(actual.byteLength).toBe(32);
            expect(expected.byteLength).toBe(32);
        }
    });

    it.each([undefined, null, 42, true, {}, [], { token: TOKEN }])(
        "非字符串凭据 %j 拒绝且不抛错",
        (actual) => expect(tokenEquals(actual, TOKEN)).toBe(false),
    );

    it.each(["虚构令牌🔑", "é", "e\u0301", "\ud800", "\ud801", "", "a".repeat(4096)])(
        "精确比较 Unicode 与不同长度，不做规范化：%j",
        (token) => {
            const opts = { allowRawHeader: true, allowQueryToken: true };
            expect(matchTokenCredential(bearerCtx(token), token)).toBe(true);
            expect(matchTokenCredential(bearerCtx(`${token}x`), token)).toBe(false);
            expect(
                matchTokenCredential(makeCtx("/", { ["Authorization"]: token }), token, opts),
            ).toBe(true);
            // URLSearchParams 按 UTF-8 编码，孤立代理项不能无损往返。
            if (token.isWellFormed()) {
                const query = new URLSearchParams({ access_token: token });
                expect(matchTokenCredential(makeCtx(`/?${query}`), token, opts)).toBe(true);
            }
            expect(matchTokenCredential(makeCtx("/"), token, opts)).toBe(false);
        },
    );

    it("不同孤立代理项和 U+FFFD 不可因 UTF-8 替换而被视为同一个凭据", () => {
        expect(matchTokenCredential(bearerCtx("\ud801"), "\ud800")).toBe(false);
        expect(matchTokenCredential(bearerCtx("\ufffd"), "\ud800")).toBe(false);
        expect(matchTokenCredential(bearerCtx("e\u0301"), "é")).toBe(false);
    });

    it("保留大小写、空头、前缀与回退语义", () => {
        const query = `/?access_token=${TOKEN}`;
        expect(
            matchTokenCredential(makeCtx(query, { authorization: `bearer ${TOKEN}` }), TOKEN),
        ).toBe(false);
        expect(
            matchTokenCredential(makeCtx(query, { authorization: "" }), TOKEN, {
                allowQueryToken: true,
            }),
        ).toBe(true);
        expect(
            matchTokenCredential(makeCtx(query, { authorization: "wrong" }), TOKEN, {
                allowQueryToken: true,
            }),
        ).toBe(true);
        // OB11 允许 token 本身包含 Bearer 前缀，Bearer 解析不匹配后仍尝试整个裸头。
        expect(
            matchTokenCredential(bearerCtx(TOKEN), `Bearer ${TOKEN}`, {
                allowRawHeader: true,
            }),
        ).toBe(true);
    });
});

describe("matchTokenCredential：allowQueryToken 查询参数", () => {
    it("相对路径 ?access_token= 命中（dummy base 解析）", () => {
        expect(
            matchTokenCredential(makeCtx(`/ws?access_token=${TOKEN}`), TOKEN, {
                allowQueryToken: true,
            }),
        ).toBe(true);
    });

    it("绝对 URL 与其他查询参数共存时同样命中", () => {
        expect(
            matchTokenCredential(
                makeCtx(`http://localhost:8080/event?foo=1&access_token=${TOKEN}`),
                TOKEN,
                { allowQueryToken: true },
            ),
        ).toBe(true);
    });

    it("未开启时忽略查询参数（Satori 只认 Bearer 头）", () => {
        expect(matchTokenCredential(makeCtx(`/v1/events?access_token=${TOKEN}`), TOKEN)).toBe(
            false,
        );
    });

    it("查询参数值错误 → 拒绝", () => {
        expect(
            matchTokenCredential(makeCtx("/ws?access_token=wrong"), TOKEN, {
                allowQueryToken: true,
            }),
        ).toBe(false);
    });
});

describe("matchTokenCredential：查询参数 URL 解析失败", () => {
    it("非法 URL → fail-closed 返回 false 且触发回调", () => {
        const calls: { url: string; err: unknown }[] = [];
        const result = matchTokenCredential(makeCtx("http://[::1"), TOKEN, {
            allowQueryToken: true,
            onQueryParseError: (url, err) => calls.push({ url, err }),
        });
        expect(result).toBe(false);
        expect(calls).toHaveLength(1);
        expect(calls[0]?.url).toBe("http://[::1");
        expect(calls[0]?.err).toBeInstanceOf(TypeError);
    });

    it("未提供回调时仍然 fail-closed 不抛错", () => {
        const ctx = makeCtx("http://[::1");
        expect(() => matchTokenCredential(ctx, TOKEN, { allowQueryToken: true })).not.toThrow();
        expect(matchTokenCredential(ctx, TOKEN, { allowQueryToken: true })).toBe(false);
    });

    it("Bearer 头已命中时不解析 URL、不触发回调", () => {
        const calls: string[] = [];
        const result = matchTokenCredential(
            makeCtx("http://[::1", { authorization: `${BEARER_PREFIX}${TOKEN}` }),
            TOKEN,
            { allowQueryToken: true, onQueryParseError: (url) => calls.push(url) },
        );
        expect(result).toBe(true);
        expect(calls).toHaveLength(0);
    });
});
