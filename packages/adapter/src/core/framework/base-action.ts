/**
 * BaseAction：协议动作基类（zod 校验 + 统一错误映射）
 *
 * 各协议动作继承并实现 `_handle`；`handle`（HTTP）/ `websocketHandle`（WS）
 * 统一做 zod 校验 + KernelError → 协议错误码映射。
 */

import type { KernelErrorCode } from "@napuketto/kernel";
import type { ZodType } from "zod";

/** 校验失败 retcode：HTTP 入口。 */
const INVALID_RETCODE_HTTP = 400;
/** 校验失败 retcode：WS 入口。 */
const INVALID_RETCODE_WS = 1400;

/** 动作执行结果（含 retcode，协议错误码由协议层映射表提供）。 */
export interface ActionResult<T> {
    retcode: number;
    status: string;
    data: T | null;
    message: string;
    echo?: unknown;
}

/** 协议错误码映射表：KernelErrorCode → 协议错误码（各协议各自实现，ADR-017）。 */
export type ErrorCodeMap = Record<KernelErrorCode, number>;

/** 动作基类：校验失败 retcode=400（HTTP）/1400（WS）。 */
export abstract class BaseAction<TPayload, TReturn> {
    abstract readonly name: string;
    abstract readonly schema: ZodType<TPayload>;
    protected abstract readonly errorCodeMap: ErrorCodeMap;

    /** 校验并执行（HTTP 入口）。 */
    handle(payload: unknown): Promise<ActionResult<TReturn>> {
        return this.run(payload, INVALID_RETCODE_HTTP);
    }

    /** 校验并执行（WS 入口，echo 透传）。 */
    async websocketHandle(payload: unknown, echo?: unknown): Promise<ActionResult<TReturn>> {
        const result = await this.run(payload, INVALID_RETCODE_WS);
        if (echo !== undefined) {
            result.echo = echo;
        }
        return result;
    }

    private async run(payload: unknown, invalidRetcode: number): Promise<ActionResult<TReturn>> {
        const parsed = this.schema.safeParse(payload);
        if (!parsed.success) {
            return this.fail(invalidRetcode, "参数校验失败");
        }
        try {
            const data = await this._handle(parsed.data);
            return { retcode: 0, status: "ok", data, message: "" };
        } catch (err) {
            return this.mapError(err);
        }
    }

    protected abstract _handle(payload: TPayload): Promise<TReturn>;

    private mapError(err: unknown): ActionResult<TReturn> {
        if (err instanceof Error && "code" in err) {
            const typed = err as Error & { code: KernelErrorCode };
            //从断言联合类型访问 code，解构会丢失 err 其余属性
            const retcode = this.errorCodeMap[typed.code] ?? this.errorCodeMap["UNKNOWN"];
            return { retcode, status: "failed", data: null, message: err.message };
        }
        if (err instanceof Error) {
            return this.fail(this.errorCodeMap["UNKNOWN"], err.message);
        }
        return this.fail(this.errorCodeMap["UNKNOWN"], "未知错误");
    }

    private fail(retcode: number, message: string): ActionResult<TReturn> {
        return { retcode, status: "failed", data: null, message };
    }
}
