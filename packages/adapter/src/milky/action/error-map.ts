/**
 * Milky 错误码映射（ADR-017：KernelErrorCode → 协议错误码，各协议自持）
 *
 * 规范语义：-400 = 参数解析失败、-403 = 未登录；其余业务错误为自定负数
 * （规范允许），取常见 HTTP 语义近似值便于应用端排查。
 */
import type { MilkyErrorCodeMap } from "./base-action.js";

export const milkyErrorCodeMap: MilkyErrorCodeMap = {
    SEND_FAILED: -500,
    PERMISSION_DENIED: -405,
    NOT_FOUND: -404,
    TIMEOUT: -504,
    NOT_LOGIN: -403,
    INVALID_PARAM: -400,
    INVALID_STATE: -409,
    UNKNOWN: -500,
};
