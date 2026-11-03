/**
 * MilkyAction.handle 契约测试（base-action.ts + error-map.ts）
 *
 * 锁定：zod 校验失败恒 -400（摘要取前 3 条 issue）、KernelError 经错误码映射表
 * 转 retcode、映射缺失回退 UNKNOWN、非 KernelError 与非 Error 抛出的兜底路径。
 */
import { KERNEL_ERROR_CODES, kernelError } from "@napuketto/kernel";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { MilkyApiAction } from "../base-action.js";
import { milkyErrorCodeMap } from "../error-map.js";
import { buildMilkyApi } from "./test-support.js";

/** 可注入行为的最小具体动作（schema / run 由用例给定）。 */
class ProbeAction extends MilkyApiAction<Record<string, never>, string> {
    readonly name = "probe";
    readonly schema: z.ZodType<Record<string, never>>;
    private readonly run: () => Promise<string>;

    constructor(schema: z.ZodType<Record<string, never>>, run: () => Promise<string>) {
        super(buildMilkyApi());
        this.schema = schema;
        this.run = run;
    }

    protected async _handle(): Promise<string> {
        return await this.run();
    }
}

/** 失败动作快捷构造（_handle 直接抛给定错误）。 */
function failingAction(err: unknown, schema = z.object({}).strict()): ProbeAction {
    return new ProbeAction(schema, async () => {
        throw err;
    });
}

describe("MilkyAction.handle：校验失败路径", () => {
    it("zod 失败 → -400，摘要含字段路径与文案", async () => {
        const act = new ProbeAction(
            z.object({ a: z.string(), b: z.number() }) as never,
            async () => "x",
        );
        const res = await act.handle({});
        expect(res.status).toBe("failed");
        expect(res.retcode).toBe(-400);
        expect(res.data).toBeNull();
        expect(res.message).toContain("参数解析失败");
        expect(res.message).toContain("a: ");
        expect(res.message).toContain("b: ");
    });

    it("多 issue 摘要只取前 3 条（分号拼接）", async () => {
        const schema = z.object({
            a: z.string(),
            b: z.number(),
            c: z.boolean(),
            d: z.array(z.string()),
        });
        const act = new ProbeAction(schema as never, async () => "x");
        const res = await act.handle({});
        const summary = res.message.replace("参数解析失败: ", "");
        expect(summary.split("; ")).toHaveLength(3);
        expect(summary).not.toContain("d:");
    });
});

describe("MilkyAction.handle：KernelError 映射", () => {
    it("全部 KernelErrorCode 经映射表转 retcode（表驱动）", async () => {
        for (const code of KERNEL_ERROR_CODES) {
            const act = failingAction(kernelError(`boom-${code}`, code));
            const res = await act.handle({});
            expect(res.status, code).toBe("failed");
            expect(res.retcode, code).toBe(milkyErrorCodeMap[code]);
            expect(res.message, code).toBe(`boom-${code}`);
        }
    });

    it("映射表缺失的 code 回退 UNKNOWN retcode（防御分支）", async () => {
        const err = kernelError("weird", "UNKNOWN");
        Object.assign(err, { code: "NOT_IN_MAP" });
        const act = failingAction(err);
        const res = await act.handle({});
        expect(res.retcode).toBe(milkyErrorCodeMap.UNKNOWN);
    });
});

describe("MilkyAction.handle：非类型化错误兜底", () => {
    it("普通 Error → UNKNOWN retcode，message 透传", async () => {
        const act = failingAction(new Error("plain"));
        const res = await act.handle({});
        expect(res.retcode).toBe(milkyErrorCodeMap.UNKNOWN);
        expect(res.message).toBe("plain");
    });

    it("非 Error 抛出（字符串）→ message = 未知错误", async () => {
        const act = failingAction("just a string");
        const res = await act.handle({});
        expect(res.retcode).toBe(milkyErrorCodeMap.UNKNOWN);
        expect(res.message).toBe("未知错误");
    });
});

describe("MilkyAction.handle：成功路径", () => {
    it("ok 信封：retcode 0 + data 透传 + message 空串", async () => {
        const act = new ProbeAction(z.object({}).strict(), async () => "payload");
        const res = await act.handle({});
        expect(res).toEqual({ status: "ok", retcode: 0, data: "payload", message: "" });
    });

    it("_handle 抛出的同步异常同样被捕获（async fn 包装）", async () => {
        const boom = vi.fn(() => {
            throw kernelError("sync", "INVALID_STATE");
        });
        const act = new ProbeAction(z.object({}).strict(), async () => {
            boom();
            return "";
        });
        const res = await act.handle({});
        expect(res.retcode).toBe(milkyErrorCodeMap.INVALID_STATE);
    });
});

describe("milkyErrorCodeMap", () => {
    it("规范语义：-400 参数 / -403 未登录；其余自定负数", () => {
        expect(milkyErrorCodeMap.INVALID_PARAM).toBe(-400);
        expect(milkyErrorCodeMap.NOT_LOGIN).toBe(-403);
        expect(milkyErrorCodeMap.NOT_FOUND).toBe(-404);
        expect(milkyErrorCodeMap.TIMEOUT).toBe(-504);
        for (const code of KERNEL_ERROR_CODES) {
            expect(milkyErrorCodeMap[code], code).toBeLessThan(0);
        }
    });
});
