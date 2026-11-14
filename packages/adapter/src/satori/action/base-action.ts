/**
 * Satori 动作基类（响应形态与 OB11 不同：直接返回资源对象，错误用 HTTP 状态码）
 *
 * - `run(payload)`：zod 校验失败 → SatoriActionError(400)；_handle 抛的
 *   KernelError → satoriHttpStatusMap 映射 HTTP 状态码（ADR-017）
 * - `SatoriActionError`：带 HTTP 状态码的动作错误（transport 层直接透传状态码）
 *
 * 执行骨架走 core action-kernel（runAction，passthrough 保 SatoriActionError
 * 原样透传）；本类只补「失败抛错 / 成功裸返资源」的 Satori 风格。
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

/** 校验失败默认状态码。 */
const INVALID_PARAM_STATUS = 400;

/**
 * Satori 动作基类：校验 + 执行 + 错误映射。
 * 成功返回资源对象（或数组/分页列表），失败抛 SatoriActionError。
 */
export abstract class BaseSatoriAction<TPayload, TReturn> {
    /** 动作名（resource.method，如 "message.create"）。 */
    abstract readonly name: string;
    /** 参数校验 schema。 */
    abstract readonly schema: ZodType<TPayload>;

    /** 校验并执行（HTTP/WS 共用）。 */
    async run(payload: unknown): Promise<TReturn> {
        const outcome = await runAction(
            {
                schema: this.schema,
                handle: (parsed) => this._handle(parsed),
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
    }

    /** 动作实现（只抛错或返回资源；不包装响应）。 */
    protected abstract _handle(payload: TPayload): Promise<TReturn>;
}
