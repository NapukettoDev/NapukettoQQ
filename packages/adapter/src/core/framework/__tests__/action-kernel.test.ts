/**
 * core/framework/action-kernel.test.ts：动作执行内核单测。
 *
 * 锁定 runAction 的协议无关骨架（三协议 BaseAction 共用）：
 *  - 成功：ok=true + data 透传；校验失败：ok=false + invalidRetcode + 消息（缺省
 *    「参数校验失败」，自定义 invalidMessage 可注入）；
 *  - KernelError 按 errorCodeMap 映射、缺项回退 UNKNOWN；
 *  - 非 KernelError（含带 code 的形状兼容错误）兜底 UNKNOWN；
 *  - passthrough 命中时原样重抛，不走映射。
 */
import { type KernelErrorCode, kernelError } from "@napuketto/kernel";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { stub } from "../../../shared/__tests__/stub.js";
import { type ActionKernelSpec, type ErrorCodeMap, runAction } from "../action-kernel.js";

/** OB11 风格映射表（与 onebot11 error-map 同构的最小子集）。 */
const FULL_MAP: ErrorCodeMap = {
    SEND_FAILED: 1200,
    PERMISSION_DENIED: 1300,
    NOT_FOUND: 1404,
    TIMEOUT: 1500,
    NOT_LOGIN: 1401,
    INVALID_PARAM: 1400,
    INVALID_STATE: 1600,
    UNKNOWN: 1501,
};

/** 组装最小 spec（schema = { value: string }；handle 行为注入）。 */
function makeSpec(
    overrides?: Partial<ActionKernelSpec<{ value: string }, string>>,
): ActionKernelSpec<{ value: string }, string> {
    return {
        schema: z.object({ value: z.string() }),
        handle: async (payload) => `ok:${payload.value}`,
        errorCodeMap: FULL_MAP,
        invalidRetcode: 400,
        ...overrides,
    };
}

describe("runAction：成功与校验", () => {
    it("成功：ok=true + data 透传", async () => {
        const outcome = await runAction(makeSpec(), { value: "入参" });
        expect(outcome).toEqual({ ok: true, data: "ok:入参" });
    });

    it("校验失败：ok=false + invalidRetcode + 缺省消息", async () => {
        const outcome = await runAction(makeSpec(), { nope: 1 });
        expect(outcome).toEqual({ ok: false, retcode: 400, message: "参数校验失败" });
    });

    it("校验失败：invalidRetcode 可自定义（OB11 WS 1400 / Milky -400 口径）", async () => {
        const outcome = await runAction(makeSpec({ invalidRetcode: -400 }), {});
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) {
            expect(outcome.retcode).toBe(-400);
        }
    });

    it("校验失败：invalidMessage 注入 zod 摘要（Milky 口径）", async () => {
        const outcome = await runAction(
            makeSpec({
                invalidMessage: (error) =>
                    `参数解析失败: ${error.issues.map((i) => i.message).join(";")}`,
            }),
            {},
        );
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) {
            expect(outcome.message.startsWith("参数解析失败: ")).toBe(true);
        }
    });
});

describe("runAction：错误映射", () => {
    it("KernelError：按 errorCodeMap 映射 retcode，message 透传", async () => {
        const outcome = await runAction(
            makeSpec({
                handle: async () => {
                    throw kernelError("群不存在", "NOT_FOUND");
                },
            }),
            { value: "x" },
        );
        expect(outcome).toEqual({ ok: false, retcode: 1404, message: "群不存在" });
    });

    it("映射表缺项：回退 UNKNOWN 对应 retcode", async () => {
        // 仅登记 UNKNOWN（Record 类型要求全集，测试用断言收窄模拟漏登记）
        const partial = stub<ErrorCodeMap>({ UNKNOWN: 1599 });
        const outcome = await runAction(
            makeSpec({
                errorCodeMap: partial,
                handle: async () => {
                    throw kernelError("超时", "TIMEOUT");
                },
            }),
            { value: "x" },
        );
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) {
            expect(outcome.retcode).toBe(1599);
        }
    });

    it("普通 Error：兜底 UNKNOWN，message 透传", async () => {
        const outcome = await runAction(
            makeSpec({
                handle: async () => {
                    throw new Error("意外失败");
                },
            }),
            { value: "x" },
        );
        expect(outcome).toEqual({ ok: false, retcode: 1501, message: "意外失败" });
    });

    it("带 code 的普通 Error（非 KernelError）：不按 code 映射，兜底 UNKNOWN", async () => {
        const outcome = await runAction(
            makeSpec({
                handle: async () => {
                    const err: Error & { code: KernelErrorCode } = Object.assign(
                        new Error("带码错误"),
                        { code: "PERMISSION_DENIED" as KernelErrorCode },
                    );
                    throw err;
                },
            }),
            { value: "x" },
        );
        expect(outcome).toEqual({ ok: false, retcode: 1501, message: "带码错误" });
    });

    it("非 Error 抛出物：message=未知错误", async () => {
        const outcome = await runAction(
            makeSpec({
                handle: async () => {
                    throw "字符串错误";
                },
            }),
            { value: "x" },
        );
        expect(outcome).toEqual({ ok: false, retcode: 1501, message: "未知错误" });
    });
});

describe("runAction：passthrough", () => {
    class ProtocolError extends Error {}

    it("passthrough 命中：原样重抛，不走映射", async () => {
        const err = new ProtocolError("协议自有错误");
        await expect(
            runAction(
                makeSpec({
                    handle: async () => {
                        throw err;
                    },
                    passthrough: (e) => e instanceof ProtocolError,
                }),
                { value: "x" },
            ),
        ).rejects.toBe(err);
    });

    it("passthrough 未命中：照常走映射表", async () => {
        const outcome = await runAction(
            makeSpec({
                handle: async () => {
                    throw new Error("普通错误");
                },
                passthrough: (e) => e instanceof ProtocolError,
            }),
            { value: "x" },
        );
        expect(outcome).toEqual({ ok: false, retcode: 1501, message: "普通错误" });
    });

    it("未配置 passthrough：SatoriActionError 形状错误也走映射兜底", async () => {
        const outcome = await runAction(
            makeSpec({
                handle: async () => {
                    throw Object.assign(new Error("带状态错误"), { status: 404 });
                },
            }),
            { value: "x" },
        );
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) {
            expect(outcome.retcode).toBe(1501);
        }
    });
});
