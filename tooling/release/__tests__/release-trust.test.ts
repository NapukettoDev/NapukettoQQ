/**
 * release-trust.test.ts：OIDC 信任配置探测层单测。
 *
 * 覆盖包名转义 / 端点拼接 / 三种探测结论（ok / missing / error）/
 * id_token 请求的 audience 与凭证头。全部用假 fetch，不触网。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { isOidcTrustedPublishing } from "../release-npm.ts";
import {
    escapePackageName,
    exchangeUrl,
    fetchGithubIdToken,
    probePackageTrust,
    probeTrustConfigs,
} from "../release-trust.ts";

const REGISTRY = "https://registry.npmjs.org";

/** 构造一个带 JSON body 的 Response。 */
function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });
}

afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});

describe("escapePackageName / exchangeUrl", () => {
    it("把 scoped 包的斜杠转成 %2F", () => {
        expect(escapePackageName("@napuketto/kernel")).toBe("@napuketto%2Fkernel");
        expect(escapePackageName("create-napukettoqq")).toBe("create-napukettoqq");
    });

    it("拼出 npm CLI 同款换 token 端点", () => {
        expect(exchangeUrl(REGISTRY, "@napuketto/kernel")).toBe(
            "https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/@napuketto%2Fkernel",
        );
    });
});

describe("probePackageTrust", () => {
    it("200 且带 token → ok", async () => {
        const fetchImpl = vi.fn<typeof fetch>();
        fetchImpl.mockResolvedValue(jsonResponse({ token: "short-lived" }));
        const result = await probePackageTrust("id", REGISTRY, "@napuketto/kernel", fetchImpl);
        expect(result).toEqual({ name: "@napuketto/kernel", status: "ok", detail: "已换到 token" });
        const init = fetchImpl.mock.calls[0]?.[1];
        expect(init?.method).toBe("POST");
        expect(init?.headers).toMatchObject({ authorization: "Bearer id" });
    });

    it("200 但缺 token → error（不据此拦截发布）", async () => {
        const fetchImpl = vi.fn<typeof fetch>();
        fetchImpl.mockResolvedValue(jsonResponse({}));
        const result = await probePackageTrust("id", REGISTRY, "@napuketto/kernel", fetchImpl);
        expect(result.status).toBe("error");
    });

    it("404 → missing，并带出 registry 的 message", async () => {
        const fetchImpl = vi.fn<typeof fetch>();
        fetchImpl.mockResolvedValue(
            jsonResponse({ message: "OIDC token exchange error - package not found" }, 404),
        );
        const result = await probePackageTrust("id", REGISTRY, "@napuketto/kernel", fetchImpl);
        expect(result.status).toBe("missing");
        expect(result.detail).toContain("package not found");
    });

    it("非 2xx（非 404）→ error", async () => {
        const fetchImpl = vi.fn<typeof fetch>();
        fetchImpl.mockResolvedValue(jsonResponse({ message: "boom" }, 503));
        const result = await probePackageTrust("id", REGISTRY, "@napuketto/kernel", fetchImpl);
        expect(result.status).toBe("error");
        expect(result.detail).toContain("503");
    });

    it("网络异常 → error 而不是抛出", async () => {
        const fetchImpl = vi.fn<typeof fetch>();
        fetchImpl.mockRejectedValue(new Error("ECONNRESET"));
        const result = await probePackageTrust("id", REGISTRY, "@napuketto/kernel", fetchImpl);
        expect(result.status).toBe("error");
        expect(result.detail).toContain("ECONNRESET");
    });

    it("保持输入顺序返回（并发池不打乱结果）", async () => {
        const names = ["a", "b", "c", "d", "e"];
        const fetchImpl = vi.fn<typeof fetch>();
        fetchImpl.mockResolvedValue(jsonResponse({ token: "t" }));
        const results = await probeTrustConfigs("id", REGISTRY, names, fetchImpl);
        expect(results.map((result) => result.name)).toEqual(names);
    });
});

describe("isOidcTrustedPublishing", () => {
    it("只有 Actions 注入的 id_token 端点变量齐全时才算 OIDC 模式", () => {
        expect(
            isOidcTrustedPublishing({
                ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.example/",
                ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
            }),
        ).toBe(true);
        expect(isOidcTrustedPublishing({})).toBe(false);
        expect(
            isOidcTrustedPublishing({
                ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.example/",
            }),
        ).toBe(false);
    });
});

describe("fetchGithubIdToken", () => {
    it("请求 GitHub 的 token 端点并带 npm audience", async () => {
        vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_URL", "https://token.actions.example/?api-version=2");
        vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "request-token");
        const fetchImpl = vi.fn<typeof fetch>();
        fetchImpl.mockResolvedValue(jsonResponse({ value: "the-id-token" }));
        const token = await fetchGithubIdToken(REGISTRY, fetchImpl);
        expect(token).toBe("the-id-token");
        const input = fetchImpl.mock.calls[0]?.[0];
        const url = new URL(String(input));
        expect(url.searchParams.get("audience")).toBe("npm:registry.npmjs.org");
        expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({
            authorization: "Bearer request-token",
        });
    });

    it("缺少 id-token 环境变量时抛错（job 未声明 id-token: write）", async () => {
        vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_URL", "");
        vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "");
        await expect(fetchGithubIdToken(REGISTRY)).rejects.toThrow(/id-token/);
    });

    it("GitHub 返回非 2xx 时抛错", async () => {
        vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_URL", "https://token.actions.example/");
        vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "request-token");
        const fetchImpl = vi.fn<typeof fetch>();
        fetchImpl.mockResolvedValue(jsonResponse({}, 403));
        await expect(fetchGithubIdToken(REGISTRY, fetchImpl)).rejects.toThrow(/403/);
    });
});
