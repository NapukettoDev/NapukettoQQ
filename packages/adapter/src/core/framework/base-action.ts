/**
 * BaseAction：协议动作基类（zod 校验 + 统一错误映射）
 *
 * 各协议动作继承并实现 `_handle`；`handle`（HTTP）/ `websocketHandle`（WS）
 * 统一做 zod 校验 + KernelError → 协议错误码映射。执行骨架在
 * action-kernel.ts（runAction，三协议共用）；本类只补 OB11 信封与 WS echo。
 */

import type { ZodType } from "zod";
import { runAction } from "./action-kernel.js";

export type { ErrorCodeMap } from "./action-kernel.js";

import type { ErrorCodeMap } from "./action-kernel.js";

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
        const outcome = await runAction(
            {
                schema: this.schema,
                handle: (parsed) => this._handle(parsed),
                errorCodeMap: this.errorCodeMap,
                invalidRetcode,
            },
            payload,
        );
        return outcome.ok
            ? { retcode: 0, status: "ok", data: outcome.data, message: "" }
            : {
                  retcode: outcome.retcode,
                  status: "failed",
                  data: null,
                  message: outcome.message,
              };
    }

    protected abstract _handle(payload: TPayload): Promise<TReturn>;
}
