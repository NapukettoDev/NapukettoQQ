/**
 * 原生调用结果解包（ADR-009 统一错误语义）：wrapper.node 的 service 方法大多返回 `{ result, errMsg }`。
 * unwrap 严格（result 为 number 且非 0 即抛）；checkLooseResult 宽松（result 缺失/非数字视为成功，
 * 兼容某些 API 成功时 result 缺省或为对象）；unwrapResult 按 errMsg 映射语义错误码（msg 系专用）。
 */

import { type KernelErrorCode, kernelError } from "../infra/index.js";
import { isRecord } from "../infra/type-guards.js";
import type { GeneralCallResult } from "../types/index.js";

/** errMsg 关键词 → 错误码规则（顺序即优先级，命中任一组关键词即映射）。 */
const RESULT_CODE_RULES: ReadonlyArray<{ code: KernelErrorCode; keywords: readonly string[] }> = [
    { code: "NOT_LOGIN", keywords: ["未登录", "login"] },
    { code: "PERMISSION_DENIED", keywords: ["无权限", "permission"] },
    { code: "NOT_FOUND", keywords: ["不存在", "not found"] },
];

/** 按 errMsg 关键词映射错误码（未命中 → UNKNOWN）。 */
function mapResultCode(msg: string): KernelErrorCode {
    for (const rule of RESULT_CODE_RULES) {
        if (rule.keywords.some((k) => msg.includes(k))) {
            return rule.code;
        }
    }
    return "UNKNOWN";
}

/** 原生 result 解包（result 字段非 0 抛 KernelError）。 */
export function unwrap(label: string, result: number, errMsg?: string): void {
    if (result === 0) {
        return;
    }
    throw kernelError(`${label} 失败: ${errMsg ?? "无错误详情"}`, "UNKNOWN");
}

/**
 * 宽松 result 校验（result 为数字非 0 视为失败；缺失/非对象/非数字视为成功）。
 *
 * 入参故意收为 unknown：原生方法返回形状在探测期不稳定，调用方无需为
 * 「把返回值塞进宽松形状」再写 `as { result?: unknown }` 断言。
 */
export function checkLooseResult(label: string, res: unknown): void {
    if (!isRecord(res)) {
        return;
    }
    const result = res["result"];
    if (typeof result !== "number" || result === 0) {
        return;
    }
    throw kernelError(`${label} 失败: ${String(res["errMsg"] ?? "")}`, "UNKNOWN");
}

/** 原生结果解包：result !== 0 抛 KernelError（errMsg 语义映射错误码）。 */
export function unwrapResult<T extends GeneralCallResult>(label: string, raw: T): void {
    if (raw.result === 0) {
        return;
    }
    const msg = raw.errMsg || "无错误详情";
    // 语义码优先（未登录/无权限/不存在），未命中且为 sendMsg 时兜底 SEND_FAILED
    let code = mapResultCode(msg);
    if (code === "UNKNOWN" && label === "sendMsg") {
        code = "SEND_FAILED";
    }
    throw kernelError(`${label} 失败: ${msg}`, code);
}
