/**
 * 协议层 Token 鉴权原语（ADR-002：network 只提供 AuthorizeHook，规则归协议层）
 *
 * 三协议既有方言全部参数化，transport 不再各自重复解析：
 *  - Bearer 头：`Authorization: Bearer <token>`（`authorization` / `Authorization`
 *    两种头名都接受）；
 *  - 裸头：`authorization: <token>`（OB11 兼容，`allowRawHeader`）；
 *  - 查询参数：`?access_token=<token>`（OB11 / Milky，`allowQueryToken`）。
 *
 * 相对路径（反向 WS 握手行 / 升级行）没有 origin，`new URL()` 必抛，固定以 dummy
 * base `http://localhost` 解析；解析失败 fail-closed，并按需回调留痕（Milky debug）。
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { AuthorizeHook, RequestContext } from "@napuketto/network";

/** Authorization 头 Bearer 前缀。 */
export const BEARER_PREFIX = "Bearer ";

/** 查询参数 URL 解析用的 dummy base（相对路径必须有 base 才能解析）。 */
const QUERY_BASE = "http://localhost";

/**
 * 固定长度摘要交给恒定时间比较原语，不因输入长度不同抛错。
 * UTF-16LE 保留 JS 字符串的码元（UTF-8 会把不同孤立代理项都替换为 U+FFFD）。
 * 哈希计算仍与输入长度相关，不能据此宣称整个鉴权流程恒定耗时。
 */
export function tokenEquals(actual: unknown, expected: string | undefined): boolean {
    if (typeof actual !== "string" || typeof expected !== "string") {
        return false;
    }
    const digest = (value: string): Buffer =>
        createHash("sha256").update(value, "utf16le").digest();
    return timingSafeEqual(digest(actual), digest(expected));
}

/** Token 鉴权方言开关（缺省全部关闭 = 仅校验 Bearer 头）。 */
export interface TokenAuthOptions {
    /** 是否允许 URL 查询参数 ?access_token=<token> 兜底（默认 false）。 */
    allowQueryToken?: boolean | undefined;
    /** 是否允许裸 authorization 头直接等于 token（OB11 兼容，默认 false）。 */
    allowRawHeader?: boolean | undefined;
    /** 查询参数 URL 解析失败通知，避免诊断路径携带请求原文。 */
    onQueryParseError?: (() => void) | undefined;
}

/**
 * 请求凭据匹配（头优先，查询参数兜底）。
 *
 * 方言差异固定在开关上：带 `Bearer ` 前缀但值不匹配时，只有 `allowRawHeader`
 * （OB11 宽松模式）会继续尝试裸头与查询参数；Milky / Satori 直接拒绝，保持各自
 * 既有语义（Satori 不读查询参数，两个开关都不开）。
 */
export function matchTokenCredential(
    ctx: RequestContext,
    token: string,
    opts?: TokenAuthOptions,
): boolean {
    const auth = ctx.headers["authorization"] ?? ctx.headers["Authorization"];
    if (auth?.startsWith(BEARER_PREFIX)) {
        if (tokenEquals(auth.slice(BEARER_PREFIX.length), token)) {
            return true;
        }
        // 前缀存在但值不匹配：Milky / Satori 立即拒绝，不降级到查询参数。
        if (opts?.allowRawHeader !== true) {
            return false;
        }
    }
    if (opts?.allowRawHeader === true && tokenEquals(auth, token)) {
        return true;
    }
    if (opts?.allowQueryToken === true) {
        try {
            const parsed = new URL(ctx.url, QUERY_BASE);
            return tokenEquals(parsed.searchParams.get("access_token"), token);
        } catch {
            opts.onQueryParseError?.();
            return false;
        }
    }
    return false;
}

/**
 * 构造鉴权钩子：token 未配置（undefined 或空串）时返回 undefined，装配方不挂钩子。
 */
export function createTokenAuthorize(
    token: string | undefined,
    opts?: TokenAuthOptions,
): AuthorizeHook | undefined {
    if (token === undefined || token === "") {
        return undefined;
    }
    return (ctx) => matchTokenCredential(ctx, token, opts);
}
