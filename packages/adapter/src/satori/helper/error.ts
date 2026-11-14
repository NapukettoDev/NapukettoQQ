/**
 * Satori 错误映射：KernelErrorCode → HTTP 状态码
 * 与 OB11 的 retcode 不同，Satori 直接用 HTTP 状态码表达错误。
 * 动作未实现 → 501；API 不存在 → 404；鉴权失败 → 401。
 */
import type { KernelErrorCode } from "@napuketto/kernel";

/** KernelErrorCode → HTTP 状态码映射表。 */
export const satoriHttpStatusMap: Record<KernelErrorCode, number> = {
    SEND_FAILED: 500,
    PERMISSION_DENIED: 403,
    NOT_FOUND: 404,
    TIMEOUT: 500,
    NOT_LOGIN: 403,
    INVALID_PARAM: 400,
    INVALID_STATE: 500,
    UNKNOWN: 500,
};

/** HTTP 状态码常量。 */
export const HTTP_STATUS = {
    ok: 200,
    badRequest: 400,
    unauthorized: 401,
    forbidden: 403,
    notFound: 404,
    notImplemented: 501,
    serverError: 500,
} as const;
