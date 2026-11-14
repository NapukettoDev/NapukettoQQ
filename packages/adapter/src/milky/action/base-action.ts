/**
 * Milky 动作运行时：声明式动作工厂 + 响应信封 + 错误码映射。
 *
 * 与 OB11 分离的原因：Milky 响应信封无 echo、参数解析失败恒 retcode=-400
 * （规范），不复用 OB11 的 400/1400 语义；响应信封由 transport 组装
 * （status/retcode/data/message 原样透传）。执行骨架走 core runAction
 * （zod safeParse → 执行 → isKernelError 统一映射，映射表收拢为本文件
 * milkyErrorCodeMap）。
 */
import type { KernelErrorCode } from "@napuketto/kernel";
import type { ZodError, ZodType } from "zod";
import { runAction } from "../../core/index.js";

/** Milky 动作结果（retcode 为规范负数族；transport 原样组装信封）。 */
export interface MilkyActionResult<T> {
    status: "ok" | "failed";
    retcode: number;
    data: T | null;
    message: string;
}

/** Milky 动作对象（工厂产出）。 */
export interface MilkyAction<TPayload = unknown, TReturn = unknown> {
    readonly name: string;
    readonly schema: ZodType<TPayload>;
    /** 校验并执行（HTTP /api 入口；WS /event 不承载动作）。 */
    handle(payload: unknown): Promise<MilkyActionResult<TReturn>>;
}

/** KernelErrorCode → Milky retcode 映射表（-400/-403 规范语义，其余取常见 HTTP 语义近似负数）。 */
export const milkyErrorCodeMap: Record<KernelErrorCode, number> = {
    SEND_FAILED: -500,
    PERMISSION_DENIED: -405,
    NOT_FOUND: -404,
    TIMEOUT: -504,
    NOT_LOGIN: -403,
    INVALID_PARAM: -400,
    INVALID_STATE: -409,
    UNKNOWN: -500,
};

/** zod 错误摘要（单行，issues 取前 3 条）。 */
function zodSummary(error: ZodError<unknown>): string {
    const parts: string[] = [];
    for (const issue of error.issues.slice(0, 3)) {
        parts.push(`${issue.path.map(String).join(".")}: ${issue.message}`);
    }
    return parts.join("; ");
}

/** 声明式动作工厂：闭包依赖 + 统一信封与错误映射。 */
export function defineMilkyAction<TPayload, TReturn>(spec: {
    name: string;
    schema: ZodType<TPayload>;
    handle: (payload: TPayload) => Promise<TReturn>;
}): MilkyAction<TPayload, TReturn> {
    return {
        name: spec.name,
        schema: spec.schema,
        handle: async (payload) => {
            const outcome = await runAction(
                {
                    schema: spec.schema,
                    handle: spec.handle,
                    errorCodeMap: milkyErrorCodeMap,
                    invalidRetcode: -400,
                    invalidMessage: (error) => `参数解析失败: ${zodSummary(error)}`,
                },
                payload,
            );
            return outcome.ok
                ? { status: "ok", retcode: 0, data: outcome.data, message: "" }
                : {
                      status: "failed",
                      retcode: outcome.retcode,
                      data: null,
                      message: outcome.message,
                  };
        },
    };
}
