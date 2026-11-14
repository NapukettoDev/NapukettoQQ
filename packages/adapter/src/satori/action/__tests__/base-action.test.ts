/**
 * satori/action/base-action.test.ts：defineSatoriAction 错误包装单测。
 *
 * 与 OB11 retcode 信封不同：Satori 动作成功直接返回资源对象，错误抛
 * SatoriActionError（HTTP 状态码）：
 *  - zod 校验失败 → 400
 *  - SatoriActionError 原样透传（501 等）
 *  - KernelError → satoriHttpStatusMap 映射
 *  - 普通 Error / 非 Error → 500 兜底
 */
import { kernelError } from "@napuketto/kernel";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineSatoriAction, SatoriActionError } from "../base-action.js";

/** 测试动作（schema 与 handle 行为注入）。 */
function testAction(handler: (payload: { v: string }) => Promise<string> = async (p) => p.v) {
    return defineSatoriAction({
        name: "test.action",
        schema: z.object({ v: z.string() }),
        handle: handler,
    });
}

describe("defineSatoriAction", () => {
    it("成功：直接返回 handle 结果（无信封）", async () => {
        const action = testAction();
        await expect(action.run({ v: "值" })).resolves.toBe("值");
    });

    it("校验失败：SatoriActionError(400, 参数校验失败)", async () => {
        const action = testAction();
        await expect(action.run({ v: 123 })).rejects.toMatchObject({
            status: 400,
            message: "参数校验失败",
        });
    });

    it("SatoriActionError 原样透传（不二次包装）", async () => {
        const action = testAction(async () => {
            throw new SatoriActionError(501, "平台不支持");
        });
        await expect(action.run({ v: "x" })).rejects.toMatchObject({ status: 501 });
    });

    it.each([
        { code: "NOT_FOUND", expected: 404 },
        { code: "PERMISSION_DENIED", expected: 403 },
        { code: "NOT_LOGIN", expected: 403 },
        { code: "INVALID_PARAM", expected: 400 },
        { code: "SEND_FAILED", expected: 500 },
        { code: "TIMEOUT", expected: 500 },
        { code: "INVALID_STATE", expected: 500 },
        { code: "UNKNOWN", expected: 500 },
    ] as const)("KernelError $code → HTTP $expected", async ({ code, expected }) => {
        const action = testAction(async () => {
            throw kernelError("业务失败", code);
        });
        await expect(action.run({ v: "x" })).rejects.toMatchObject({
            status: expected,
            message: "业务失败",
        });
    });

    it("普通 Error → 500（message 透传）", async () => {
        const action = testAction(async () => {
            throw new Error("意外错误");
        });
        await expect(action.run({ v: "x" })).rejects.toMatchObject({
            status: 500,
            message: "意外错误",
        });
    });

    it("非 Error 抛出物 → 500「未知错误」", async () => {
        const action = testAction(async () => {
            throw 42;
        });
        await expect(action.run({ v: "x" })).rejects.toMatchObject({
            status: 500,
            message: "未知错误",
        });
    });

    it("handle 只调用一次且入参为解析后 payload", async () => {
        const handler = vi.fn(async (p: { v: string }) => p.v);
        const action = testAction(handler);
        await action.run({ v: "入参", junk: "剥离" });
        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler).toHaveBeenCalledWith({ v: "入参" });
    });
});

describe("SatoriActionError", () => {
    it("status 与 message 保存；instanceof Error", () => {
        const err = new SatoriActionError(404, "不存在");
        expect(err).toBeInstanceOf(Error);
        expect(err.status).toBe(404);
        expect(err.message).toBe("不存在");
        expect(err.name).toBe("Error");
    });
});
