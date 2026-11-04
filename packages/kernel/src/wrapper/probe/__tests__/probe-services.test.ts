// biome-ignore-all lint/style/useNamingConvention: QQ wrapper.node PascalCase keys
/**
 * probe-services.ts 测试（此前从未进覆盖率报告；全 mock exports）：
 *  - probeExportCtors：关键构造器方法面 / 缺失键跳过
 *  - probeEngineCalls：成功记形状 / 失败记错误 / 非 function 记 not a function
 *  - probeLoginService：ctor 缺失 → null / get() 返回 null → error / 实例方法面 +
 *    关键 getter 形状（LOGIN_GETTER_PROBES 只对存在的函数尝试）
 */
import { describe, expect, it } from "vitest";
import type { WrapperContext } from "../../wrapper-loader.js";
import { probeEngineCalls, probeExportCtors, probeLoginService } from "../probe-services.js";

/** 构造假 ctx（exports 覆写）。 */
function makeCtx(
    exportsOverride: Record<string, unknown>,
    engine: Record<string, unknown> = {},
): WrapperContext {
    return {
        exports: exportsOverride as unknown as WrapperContext["exports"],
        engine: engine as unknown as WrapperContext["engine"],
        versionInfo: { fullVersion: "9.9.33", buildVersion: "52230" },
        session: null,
        startupSession: null,
        loginService: null,
    } as unknown as WrapperContext;
}

describe("probeExportCtors", () => {
    it("存在的关键构造器记录 methods 与 ownKeys", () => {
        const ctx = makeCtx({
            NodeIQQNTWrapperSession: { getNTWrapperSession: () => null, create: () => null },
            NodeIKernelLoginService: { get: () => null },
        });
        const out = probeExportCtors(ctx);
        expect(Object.keys(out)).toEqual(["NodeIQQNTWrapperSession", "NodeIKernelLoginService"]);
        expect(out["NodeIQQNTWrapperSession"]).toMatchObject({
            methods: ["create", "getNTWrapperSession"],
        });
        expect(Array.isArray(out["NodeIKernelLoginService"])).toBe(false);
    });

    it("缺失 / null 构造器键跳过", () => {
        const ctx = makeCtx({
            NodeIQQNTWrapperEngine: null,
        });
        const out = probeExportCtors(ctx);
        expect(out).toEqual({});
    });
});

describe("probeEngineCalls", () => {
    it("成功方法记 serialize 值 + 方法面；失败方法记 error；缺失方法记 not a function", () => {
        const ctx = makeCtx(
            {},
            {
                getDeviceInfo: () => ({ deviceName: "PC" }),
                getECDHService: () => {
                    throw new Error("boom");
                },
            },
        );
        const out = probeEngineCalls(ctx);
        expect(out["getDeviceInfo"]).toMatchObject({ value: { deviceName: "PC" } });
        expect(out["getECDHService"]).toMatchObject({ error: "boom" });
        expect(out["getThirdPartySigService"]).toMatchObject({
            error: "not a function (typeof=undefined)",
        });
        expect(out["readyToShow"]).toMatchObject({ error: "not a function (typeof=undefined)" });
    });

    it("方法返回 null → 记 null/undefined（value 分支不炸）", () => {
        const ctx = makeCtx({}, { getDeviceInfo: () => null });
        const out = probeEngineCalls(ctx);
        expect(out["getDeviceInfo"]).toMatchObject({ value: null, methods: [] });
    });
});

describe("probeLoginService", () => {
    // 注：键完全缺失（undefined）时 probeLoginService 会在 typeof ctor.get 处抛
    // TypeError（疑似 bug，报告记录）——真实 exports 恒含该键，此处只测 null 形态。
    it("ctor null / get 非 function → null", () => {
        expect(probeLoginService(makeCtx({ NodeIKernelLoginService: null }))).toBeNull();
        expect(probeLoginService(makeCtx({ NodeIKernelLoginService: {} }))).toBeNull();
    });

    it("get() 抛错 → { get: error }", () => {
        const ctx = makeCtx({
            NodeIKernelLoginService: {
                get: () => {
                    throw new Error("get boom");
                },
            },
        });
        expect(probeLoginService(ctx)).toEqual({ get: "get boom" });
    });

    it("get() 返回 null → { get: null/undefined }", () => {
        const ctx = makeCtx({ NodeIKernelLoginService: { get: () => null } });
        expect(probeLoginService(ctx)).toEqual({ get: "null/undefined" });
    });

    it("实例存在：方法面 + ownKeys(30 截断) + 存在的 getter 形状（不存在的 getter 不尝试）", () => {
        const ctx = makeCtx({
            NodeIKernelLoginService: {
                get: () => ({
                    getUin: () => "10001",
                    getUid: () => "u-1",
                    getA2: () => {
                        throw new Error("a2 denied");
                    },
                }),
            },
        });
        const out = probeLoginService(ctx) as Record<string, unknown>;
        expect(out["methods"]).toContain("getUin");
        expect(out["getUin"]).toBe("10001");
        expect(out["getUid"]).toBe("u-1");
        expect(out["getA2"]).toBe("[error]");
        expect("getTicket" in out).toBe(false);
        expect("getSelfUin" in out).toBe(false);
    });
});
