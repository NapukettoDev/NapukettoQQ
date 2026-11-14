/**
 * Satori 动作运行时：声明式动作工厂 + HTTP 状态码错误。
 *
 * 响应形态与 OB11 / Milky 不同：成功直接返回资源对象（或数组/分页列表），
 * 失败抛 SatoriActionError（带 HTTP 状态码，transport 层透传）。执行骨架走
 * core runAction（passthrough 保 SatoriActionError 原样透传，不做二次映射）。
 */

import type { ZodType } from "zod";
import { runAction } from "../../core/index.js";
import { satoriHttpStatusMap } from "../helper/index.js";

/** 动作错误（带 HTTP 状态码；由 transport 层透传）。 */
export class SatoriActionError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

/** Satori 动作对象（工厂产出；HTTP / WS 入口共用）。 */
export interface SatoriAction<TPayload = unknown, TReturn = unknown> {
    /** 动作名（resource.method，如 "message.create"）。 */
    readonly name: string;
    readonly schema: ZodType<TPayload>;
    /** 校验并执行：成功返回资源对象，失败抛 SatoriActionError。 */
    run(payload: unknown): Promise<TReturn>;
}

/** 校验失败默认状态码。 */
const INVALID_PARAM_STATUS = 400;

/** 声明式动作工厂：闭包依赖 + 统一校验与错误映射。 */
export function defineSatoriAction<TPayload, TReturn>(spec: {
    name: string;
    schema: ZodType<TPayload>;
    handle: (payload: TPayload) => Promise<TReturn>;
}): SatoriAction<TPayload, TReturn> {
    return {
        name: spec.name,
        schema: spec.schema,
        run: async (payload) => {
            const outcome = await runAction(
                {
                    schema: spec.schema,
                    handle: spec.handle,
                    errorCodeMap: satoriHttpStatusMap,
                    invalidRetcode: INVALID_PARAM_STATUS,
                    passthrough: (err) => err instanceof SatoriActionError,
                },
                payload,
            );
            if (!outcome.ok) {
                throw new SatoriActionError(outcome.retcode, outcome.message);
            }
            return outcome.data;
        },
    };
}
