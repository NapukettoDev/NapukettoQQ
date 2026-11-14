/**
 * onebot11/action/base-action.test.ts：defineOb11Action 校验与错误映射单测。
 *
 * 锁定 OB11 动作运行时的统一行为：
 *  - handle：zod 校验失败 retcode=400；成功 retcode=0；KernelError 经共享映射表
 *    （ob11ErrorCodeMap）；普通 Error / 非 Error 兜底 UNKNOWN。
 *  - websocketHandle：校验失败 retcode=1400；echo 透传；无 echo 不写字段。
 */
import { kernelError } from "@napuketto/kernel";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineOb11Action, ob11ErrorCodeMap } from "../base-action.js";

/** 可注入行为的最小测试动作（schema / handle 由用例给定）。 */
function testAction(
    handler: (payload: { value: string }) => Promise<string> = async (p) => p.value,
) {
    return defineOb11Action({
        name: "test.action",
        schema: z.object({ value: z.string() }),
        handle: handler,
    });
}

describe("Ob11Action.handle", () => {
    it("参数合法：retcode=0 / status=ok / data=返回值", async () => {
        const action = testAction();
        await expect(action.handle({ value: "你好" })).resolves.toEqual({
            retcode: 0,
            status: "ok",
            data: "你好",
            message: "",
        });
    });

    it("参数校验失败：retcode=400 / status=failed / data=null", async () => {
        const action = testAction();
        await expect(action.handle({ nope: 1 })).resolves.toEqual({
            retcode: 400,
            status: "failed",
            data: null,
            message: "参数校验失败",
        });
    });

    it("KernelError：按 ob11ErrorCodeMap 映射 retcode，message 透传", async () => {
        const action = testAction(async () => {
            throw kernelError("群不存在", "NOT_FOUND");
        });
        const result = await action.handle({ value: "x" });
        expect(result.retcode).toBe(ob11ErrorCodeMap.NOT_FOUND);
        expect(result.retcode).toBe(102);
        expect(result.status).toBe("failed");
        expect(result.data).toBeNull();
        expect(result.message).toBe("群不存在");
    });

    it("普通 Error：兜底 UNKNOWN retcode", async () => {
        const action = testAction(async () => {
            throw new Error("意外失败");
        });
        const result = await action.handle({ value: "x" });
        expect(result.retcode).toBe(ob11ErrorCodeMap.UNKNOWN);
        expect(result.retcode).toBe(999);
        expect(result.message).toBe("意外失败");
    });

    it("带 code 的普通 Error（非 KernelError）：不按 code 映射，兜底 UNKNOWN", async () => {
        // 错误判别统一 isKernelError（instanceof）：形状兼容的第三方错误
        // 不走映射表，只落 UNKNOWN 兜底。
        const action = testAction(async () => {
            const err = Object.assign(new Error("带码错误"), { code: "PERMISSION_DENIED" });
            throw err;
        });
        const result = await action.handle({ value: "x" });
        expect(result.retcode).toBe(ob11ErrorCodeMap.UNKNOWN);
        expect(result.message).toBe("带码错误");
    });

    it("非 Error 抛出物：message=未知错误", async () => {
        const action = testAction(async () => {
            throw "字符串错误";
        });
        const result = await action.handle({ value: "x" });
        expect(result.retcode).toBe(ob11ErrorCodeMap.UNKNOWN);
        expect(result.message).toBe("未知错误");
    });

    it("handle 的同步调用经 await 包装（vi.fn 断言入参）", async () => {
        const handler = vi.fn(async (p: { value: string }) => p.value);
        const action = testAction(handler);
        await action.handle({ value: "入参" });
        expect(handler).toHaveBeenCalledWith({ value: "入参" });
    });
});

describe("Ob11Action.websocketHandle", () => {
    it("校验失败：retcode=1400（WS 入口独立于 HTTP 的 400）", async () => {
        const action = testAction();
        await expect(action.websocketHandle(null)).resolves.toEqual({
            retcode: 1400,
            status: "failed",
            data: null,
            message: "参数校验失败",
        });
    });

    it("echo 透传：成功与失败路径都回填 echo", async () => {
        const action = testAction();
        const ok = await action.websocketHandle({ value: "a" }, "echo-1");
        expect(ok.echo).toBe("echo-1");
        const bad = await action.websocketHandle(null, "echo-2");
        expect(bad.echo).toBe("echo-2");
    });

    it("未传 echo：结果不含 echo 字段", async () => {
        const action = testAction();
        const result = await action.websocketHandle({ value: "a" });
        expect(result.echo).toBeUndefined();
    });

    it("错误路径同样回填 echo（websocketHandle 与 handle 共用 run）", async () => {
        const action = testAction(async () => {
            throw kernelError("发送失败", "SEND_FAILED");
        });
        const result = await action.websocketHandle({ value: "x" }, 42);
        expect(result.retcode).toBe(ob11ErrorCodeMap.SEND_FAILED);
        expect(result.retcode).toBe(100);
        expect(result.echo).toBe(42);
    });
});

describe("ob11ErrorCodeMap", () => {
    it("OB11 规范错误码（send 失败 100 族 + UNKNOWN 999）", () => {
        expect(ob11ErrorCodeMap.SEND_FAILED).toBe(100);
        expect(ob11ErrorCodeMap.INVALID_PARAM).toBe(105);
        expect(ob11ErrorCodeMap.NOT_LOGIN).toBe(104);
        expect(ob11ErrorCodeMap.UNKNOWN).toBe(999);
        for (const code of Object.values(ob11ErrorCodeMap)) {
            expect(code).toBeGreaterThan(0);
        }
    });
});
