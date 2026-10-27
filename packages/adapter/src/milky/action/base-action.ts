/**
 * MilkyAction：Milky 动作基类（zod 校验 + KernelError → 负数 retcode）
 *
 * 与 OB11 BaseAction 分离的原因：Milky 响应信封无 echo、参数解析失败恒
 * retcode=-400（规范），不复用 OB11 的 400/1400 语义。
 * 响应信封由 transport 组装（status/retcode/data/message）。
 */
import { isKernelError, type KernelErrorCode } from "@napuketto/kernel";
import type { ZodType } from "zod";

/** Milky 动作结果（retcode 为规范负数族；transport 原样组装信封）。 */
export interface MilkyActionResult<T> {
    status: "ok" | "failed";
    retcode: number;
    data: T | null;
    message: string;
}

/** KernelErrorCode → Milky retcode 映射表（-400/-403 规范语义，其余自定负数）。 */
export type MilkyErrorCodeMap = Record<KernelErrorCode, number>;

/** zod 错误摘要（单行，issues 取前 3 条）。 */
function zodSummary(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
    const parts: string[] = [];
    for (const issue of error.issues.slice(0, 3)) {
        parts.push(`${issue.path.map(String).join(".")}: ${issue.message}`);
    }
    return parts.join("; ");
}

export abstract class MilkyAction<TPayload, TReturn> {
    abstract readonly name: string;
    abstract readonly schema: ZodType<TPayload>;
    protected abstract readonly errorCodeMap: MilkyErrorCodeMap;

    protected abstract _handle(payload: TPayload): Promise<TReturn>;

    /** 校验并执行（HTTP /api 入口；WS /event 不承载动作）。 */
    async handle(payload: unknown): Promise<MilkyActionResult<TReturn>> {
        const parsed = this.schema.safeParse(payload);
        if (!parsed.success) {
            return {
                status: "failed",
                retcode: -400,
                data: null,
                message: `参数解析失败: ${zodSummary(parsed.error)}`,
            };
        }
        try {
            return { status: "ok", retcode: 0, data: await this._handle(parsed.data), message: "" };
        } catch (err) {
            if (isKernelError(err)) {
                const retcode = this.errorCodeMap[err.code] ?? this.errorCodeMap.UNKNOWN;
                return { status: "failed", retcode, data: null, message: err.message };
            }
            return {
                status: "failed",
                retcode: this.errorCodeMap.UNKNOWN,
                data: null,
                message: err instanceof Error ? err.message : "未知错误",
            };
        }
    }
}
