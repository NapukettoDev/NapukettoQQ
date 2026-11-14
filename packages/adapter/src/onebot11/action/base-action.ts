/**
 * OB11 动作运行时：声明式动作工厂 + 响应信封 + 错误码映射 + 共享解析助手。
 *
 * 动作 = `{ name, schema, handle }` 声明对象，经 defineOb11Action 组装出
 * HTTP `handle`（校验失败 retcode=400）与 WS `websocketHandle`（1400 +
 * echo 透传）两个入口；执行骨架走 core runAction（zod safeParse → 执行 →
 * isKernelError 统一映射，映射表收拢为本文件 ob11ErrorCodeMap）。
 */
import { kernelError } from "@napuketto/kernel";
import type { ZodType } from "zod";
import type { ErrorCodeMap } from "../../core/index.js";
import { runAction } from "../../core/index.js";

/** 校验失败 retcode：HTTP 入口。 */
const INVALID_RETCODE_HTTP = 400;
/** 校验失败 retcode：WS 入口。 */
const INVALID_RETCODE_WS = 1400;

/** OB11 动作结果（retcode/status/data/message 信封 + WS echo）。 */
export interface ActionResult<T> {
    retcode: number;
    status: string;
    data: T | null;
    message: string;
    echo?: unknown;
}

/** OB11 动作对象（工厂产出；HTTP 与 WS 共用同一校验执行骨架）。 */
export interface Ob11Action<TPayload = unknown, TReturn = unknown> {
    readonly name: string;
    readonly schema: ZodType<TPayload>;
    /** 校验并执行（HTTP 入口）。 */
    handle(payload: unknown): Promise<ActionResult<TReturn>>;
    /** 校验并执行（WS 入口，echo 透传）。 */
    websocketHandle(payload: unknown, echo?: unknown): Promise<ActionResult<TReturn>>;
}

/** OB11 错误码映射表（kernel KernelErrorCode → retcode；全部 OB11 动作共用）。 */
export const ob11ErrorCodeMap: ErrorCodeMap = {
    SEND_FAILED: 100,
    PERMISSION_DENIED: 101,
    NOT_FOUND: 102,
    TIMEOUT: 103,
    NOT_LOGIN: 104,
    INVALID_PARAM: 105,
    INVALID_STATE: 106,
    UNKNOWN: 999,
};

/** 声明式动作工厂：闭包依赖 + 统一信封与错误映射。 */
export function defineOb11Action<TPayload, TReturn>(spec: {
    name: string;
    schema: ZodType<TPayload>;
    handle: (payload: TPayload) => Promise<TReturn>;
}): Ob11Action<TPayload, TReturn> {
    const run = async (
        payload: unknown,
        invalidRetcode: number,
        echo?: unknown,
    ): Promise<ActionResult<TReturn>> => {
        const outcome = await runAction(
            {
                schema: spec.schema,
                handle: spec.handle,
                errorCodeMap: ob11ErrorCodeMap,
                invalidRetcode,
            },
            payload,
        );
        const result: ActionResult<TReturn> = outcome.ok
            ? { retcode: 0, status: "ok", data: outcome.data, message: "" }
            : { retcode: outcome.retcode, status: "failed", data: null, message: outcome.message };
        if (echo !== undefined) {
            result.echo = echo;
        }
        return result;
    };
    return {
        name: spec.name,
        schema: spec.schema,
        handle: (payload) => run(payload, INVALID_RETCODE_HTTP),
        websocketHandle: (payload, echo) => run(payload, INVALID_RETCODE_WS, echo),
    };
}

/** 解析单个 uin → uid（失败抛 KernelError INVALID_PARAM；多动作共用）。 */
export async function resolveUid(
    uin: string,
    uinToUid: (uins: string[]) => Promise<Map<string, string>>,
): Promise<string> {
    const uidMap = await uinToUid([uin]);
    const uid = uidMap.get(uin);
    if (uid === undefined) {
        throw kernelError(`用户 ${uin} 的 uid 解析失败`, "INVALID_PARAM");
    }
    return uid;
}
