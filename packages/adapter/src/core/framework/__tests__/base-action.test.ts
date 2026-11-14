/**
 * core/framework/base-action.test.ts：BaseAction 校验与错误映射单测。
 *
 * 锁定 OB11 系动作基类的统一行为：
 *  - handle：zod 校验失败 retcode=400；成功 retcode=0；KernelError 按映射表；
 *    映射表缺项回退 UNKNOWN；普通 Error / 非 Error 兜底 UNKNOWN。
 *  - websocketHandle：校验失败 retcode=1400；echo 透传；无 echo 不写字段。
 */
import { isKernelError, type KernelErrorCode, kernelError } from "@napuketto/kernel";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { stub } from "../../__tests__/stub.js";
import type { ErrorCodeMap } from "../base-action.js";
import { BaseAction } from "../base-action.js";

/** 最小测试动作（payload = { value: string }；_handle 行为可注入）。 */
class TestAction extends BaseAction<{ value: string }, string> {
    readonly name = "test.action";
    readonly schema = z.object({ value: z.string() });
    readonly errorCodeMap: ErrorCodeMap;

    private readonly handler: (payload: { value: string }) => Promise<string>;

    constructor(
        errorCodeMap: ErrorCodeMap,
        handler: (payload: { value: string }) => Promise<string> = async (p) => p.value,
    ) {
        super();
        this.errorCodeMap = errorCodeMap;
        this.handler = handler;
    }

    protected _handle(payload: { value: string }): Promise<string> {
        return this.handler(payload);
    }
}

/** OB11 风格映射表（与 onebot11 error-map 同构的最小子集）。 */
const FULL_MAP: Record<KernelErrorCode, number> = {
    SEND_FAILED: 1200,
    PERMISSION_DENIED: 1300,
    NOT_FOUND: 1404,
    TIMEOUT: 1500,
    NOT_LOGIN: 1401,
    INVALID_PARAM: 1400,
    INVALID_STATE: 1600,
    UNKNOWN: 1501,
};

describe("BaseAction.handle", () => {
    it("参数合法：retcode=0 / status=ok / data=返回值", async () => {
        const action = new TestAction(FULL_MAP);
        await expect(action.handle({ value: "你好" })).resolves.toEqual({
            retcode: 0,
            status: "ok",
            data: "你好",
            message: "",
        });
    });

    it("参数校验失败：retcode=400 / status=failed / data=null", async () => {
        const action = new TestAction(FULL_MAP);
        await expect(action.handle({ nope: 1 })).resolves.toEqual({
            retcode: 400,
            status: "failed",
            data: null,
            message: "参数校验失败",
        });
    });

    it("KernelError：按 errorCodeMap 映射 retcode，message 透传", async () => {
        const action = new TestAction(FULL_MAP, async () => {
            throw kernelError("群不存在", "NOT_FOUND");
        });
        const result = await action.handle({ value: "x" });
        expect(result.retcode).toBe(1404);
        expect(result.status).toBe("failed");
        expect(result.data).toBeNull();
        expect(result.message).toBe("群不存在");
    });

    it("映射表缺项：回退 UNKNOWN 对应 retcode", async () => {
        // 仅登记 UNKNOWN（Record 类型要求全集，测试用断言收窄模拟漏登记）
        const partial = stub<ErrorCodeMap>({ UNKNOWN: 1599 });
        const action = new TestAction(partial, async () => {
            throw kernelError("超时", "TIMEOUT");
        });
        const result = await action.handle({ value: "x" });
        expect(result.retcode).toBe(1599);
    });

    it("普通 Error：兜底 errorCodeMap.UNKNOWN", async () => {
        const action = new TestAction(FULL_MAP, async () => {
            throw new Error("意外失败");
        });
        const result = await action.handle({ value: "x" });
        expect(result.retcode).toBe(FULL_MAP.UNKNOWN);
        expect(result.message).toBe("意外失败");
    });

    it("带 code 的普通 Error（非 KernelError）：不按 code 映射，兜底 UNKNOWN", async () => {
        // 2026-11-14 起错误判别统一 isKernelError（instanceof）：
        // 形状兼容的第三方错误不再走映射表，只落 UNKNOWN 兜底。
        const action = new TestAction(FULL_MAP, async () => {
            const err: Error & { code: KernelErrorCode } = Object.assign(new Error("带码错误"), {
                code: "PERMISSION_DENIED" as KernelErrorCode,
            });
            throw err;
        });
        const result = await action.handle({ value: "x" });
        expect(result.retcode).toBe(FULL_MAP.UNKNOWN);
        expect(result.message).toBe("带码错误");
    });

    it("非 Error 抛出物：message=未知错误", async () => {
        const action = new TestAction(FULL_MAP, async () => {
            throw "字符串错误";
        });
        const result = await action.handle({ value: "x" });
        expect(result.retcode).toBe(FULL_MAP.UNKNOWN);
        expect(result.message).toBe("未知错误");
    });

    it("_handle 的同步调用经 await 包装（vi.fn 断言入参）", async () => {
        const handler = vi.fn(async (p: { value: string }) => p.value);
        const action = new TestAction(FULL_MAP, handler);
        await action.handle({ value: "入参" });
        expect(handler).toHaveBeenCalledWith({ value: "入参" });
    });
});

describe("BaseAction.websocketHandle", () => {
    it("校验失败：retcode=1400（WS 入口独立于 HTTP 的 400）", async () => {
        const action = new TestAction(FULL_MAP);
        await expect(action.websocketHandle(null)).resolves.toEqual({
            retcode: 1400,
            status: "failed",
            data: null,
            message: "参数校验失败",
        });
    });

    it("echo 透传：成功与失败路径都回填 echo", async () => {
        const action = new TestAction(FULL_MAP);
        const ok = await action.websocketHandle({ value: "a" }, "echo-1");
        expect(ok.echo).toBe("echo-1");
        const bad = await action.websocketHandle(null, "echo-2");
        expect(bad.echo).toBe("echo-2");
    });

    it("未传 echo：结果不含 echo 字段", async () => {
        const action = new TestAction(FULL_MAP);
        const result = await action.websocketHandle({ value: "a" });
        expect(result.echo).toBeUndefined();
    });

    it("错误路径同样回填 echo（websocketHandle 与 handle 共用 run）", async () => {
        const action = new TestAction(FULL_MAP, async () => {
            throw kernelError("发送失败", "SEND_FAILED");
        });
        const result = await action.websocketHandle({ value: "x" }, 42);
        expect(result.retcode).toBe(1200);
        expect(result.echo).toBe(42);
    });

    it("isKernelError 类型守卫自检（保证动作层 import 面可用）", () => {
        expect(isKernelError(kernelError("x"))).toBe(true);
        expect(isKernelError(new Error("x"))).toBe(false);
    });
});
