/**
 * 动作执行内核（三协议 BaseAction 共用骨架，收拢）
 *
 * zod safeParse → 执行 → `isKernelError` 统一映射 → 协议信封组装。三协议差异
 * 全部参数化：
 *  - 校验失败 retcode（OB11 HTTP 400 / WS 1400；Milky -400；Satori 400 抛 HTTP 状态）；
 *  - 校验失败消息（缺省「参数校验失败」；Milky 附 zod 摘要）；
 *  - 结果包装（OB11/Milky 组信封，Satori 抛 SatoriActionError，见各自 base-action）；
 *  - 协议自有错误透传（SatoriActionError 不走映射表）。
 * 错误判别统一 kernel `isKernelError`：不再手写 `"code" in err`。
 */
import { isKernelError, type KernelErrorCode } from "@napuketto/kernel";
import type { ZodError, ZodType } from "zod";

/**
 * 协议错误码映射表契约：KernelErrorCode → 协议错误码。
 * 各协议映射表同构（OB11 ob11ErrorCodeMap / Milky milkyErrorCodeMap /
 * Satori satoriHttpStatusMap）。
 */
export type ErrorCodeMap = Record<KernelErrorCode, number>;

/** 动作执行中间结果（协议无关）：成功带数据，失败带映射后错误码与消息。 */
export type ActionOutcome<T> =
    | { readonly ok: true; readonly data: T }
    | { readonly ok: false; readonly retcode: number; readonly message: string };

/** 动作执行依赖（schema + 实现 + 映射表 + 校验失败口径 + 透传守卫）。 */
export interface ActionKernelSpec<TPayload, TReturn> {
    /** 参数校验 schema。 */
    schema: ZodType<TPayload>;
    /** 动作实现（校验通过后调用）。 */
    handle: (payload: TPayload) => Promise<TReturn>;
    /** KernelErrorCode → 协议错误码映射表（UNKNOWN 为兜底码）。 */
    errorCodeMap: ErrorCodeMap;
    /** 校验失败 retcode。 */
    invalidRetcode: number;
    /** 校验失败消息（缺省「参数校验失败」；Milky 附 zod 摘要）。 */
    invalidMessage?: (error: ZodError<TPayload>) => string;
    /** 命中则原样重抛（如 SatoriActionError 透传给 transport 层）。 */
    passthrough?: (err: unknown) => boolean;
}

/** 执行一个协议动作：校验 → 实现 → KernelError 映射（不含协议信封组装）。 */
export async function runAction<TPayload, TReturn>(
    spec: ActionKernelSpec<TPayload, TReturn>,
    payload: unknown,
): Promise<ActionOutcome<TReturn>> {
    const parsed = spec.schema.safeParse(payload);
    if (!parsed.success) {
        const message =
            spec.invalidMessage !== undefined ? spec.invalidMessage(parsed.error) : "参数校验失败";
        return { ok: false, retcode: spec.invalidRetcode, message };
    }
    try {
        return { ok: true, data: await spec.handle(parsed.data) };
    } catch (err) {
        if (spec.passthrough?.(err) === true) {
            throw err;
        }
        if (isKernelError(err)) {
            const retcode = spec.errorCodeMap[err.code] ?? spec.errorCodeMap.UNKNOWN;
            return { ok: false, retcode, message: err.message };
        }
        return {
            ok: false,
            retcode: spec.errorCodeMap.UNKNOWN,
            message: err instanceof Error ? err.message : "未知错误",
        };
    }
}
