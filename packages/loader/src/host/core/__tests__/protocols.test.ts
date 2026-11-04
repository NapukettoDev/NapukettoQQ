/**
 * protocols.test.ts：协议装配入口单测（protocols.ts startProtocols 分支）。
 *
 * vi.mock kernel-services（createKernelServices）与 assemble-protocols
 * （assembleOb11AndSatori），env 快照隔离（vi.stubEnv + vi.resetModules + 动态 import）。
 * 覆盖：
 *  - kernel 服务创建失败（null）→ null
 *  - IPC 模式：跳过 OB11/Satori 装配，直接返回服务
 *  - 非 IPC：装配成功 → services.stopAdapters 绑定为装配返回的停止函数
 *  - 装配抛 ConfigError → 原样重抛（78 退出码契约，不得吞掉）
 *  - 装配抛其他错误 → 收敛 null（引导失败）
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigError } from "../../util.js";
import type { KernelServices } from "../kernel-services.js";

/** 装配调用记录 + 可注入抛出值（vi.hoisted：mock 工厂内可见）。 */
const h = vi.hoisted(() => {
    return {
        assembleCalls: [] as Array<{ loginUin: string }>,
        stopAdapterCalls: [] as string[],
        /** 装配抛出值（undefined = 正常路径；测试间切换）。 */
        throws: undefined as unknown,
    };
});

vi.mock("../kernel-services.js", () => ({
    createKernelServices: vi.fn(async (_kernel: unknown, ctx: { session?: unknown }) => {
        if (ctx.session === null) {
            return null;
        }
        return { ctx } as unknown as KernelServices;
    }),
}));

vi.mock("../assemble-protocols.js", () => ({
    assembleOb11AndSatori: vi.fn(
        async (_kernel: unknown, _services: unknown, loginResult: { uin: string }) => {
            h.assembleCalls.push({ loginUin: loginResult.uin });
            if (h.throws !== undefined) {
                throw h.throws;
            }
            return async () => {
                h.stopAdapterCalls.push("stop");
            };
        },
    ),
}));

/** 取全新 protocols 模块（隔离 env 快照）。 */
async function freshProtocols(): Promise<typeof import("../protocols.js")> {
    vi.resetModules();
    return await import("../protocols.js");
}

afterEach(() => {
    vi.unstubAllEnvs();
    h.assembleCalls.length = 0;
    h.stopAdapterCalls.length = 0;
    h.throws = undefined;
});

const KERNEL = {} as never;
const LOGIN = { uin: "10001", uid: "u1" };

describe("startProtocols", () => {
    it("kernel 服务创建失败（session 为空）→ null，不进装配", async () => {
        const protocols = await freshProtocols();
        const result = await protocols.startProtocols(KERNEL, { session: null }, LOGIN);
        expect(result).toBeNull();
        expect(h.assembleCalls).toHaveLength(0);
    });

    it("IPC 模式 → 跳过 OB11/Satori 装配，直接返回服务", async () => {
        vi.stubEnv("NAPUTO_IPC", "1");
        const protocols = await freshProtocols();
        const services = await protocols.startProtocols(KERNEL, { session: {} }, LOGIN);
        expect(services).not.toBeNull();
        expect(h.assembleCalls).toHaveLength(0);
        expect(services?.stopAdapters).toBeUndefined();
    });

    it("非 IPC：装配成功 → stopAdapters 绑定装配返回的停止函数", async () => {
        vi.stubEnv("NAPUTO_IPC", "");
        const protocols = await freshProtocols();
        const services = await protocols.startProtocols(KERNEL, { session: {} }, LOGIN);
        expect(services).not.toBeNull();
        expect(h.assembleCalls).toHaveLength(1);
        expect(h.assembleCalls[0]?.loginUin).toBe("10001");
        await services?.stopAdapters?.();
        expect(h.stopAdapterCalls).toEqual(["stop"]);
    });

    it("装配抛 ConfigError → 原样重抛（退出码 78 契约）", async () => {
        vi.stubEnv("NAPUTO_IPC", "");
        h.throws = new ConfigError("协议配置 kurobot 段校验失败");
        const protocols = await freshProtocols();
        await expect(
            protocols.startProtocols(KERNEL, { session: {} }, LOGIN),
        ).rejects.toMatchObject({ name: "ConfigError" });
    });

    it("装配抛其他错误 → 收敛 null（引导失败）", async () => {
        vi.stubEnv("NAPUTO_IPC", "");
        h.throws = new Error("adapter 入口损坏");
        const protocols = await freshProtocols();
        const result = await protocols.startProtocols(KERNEL, { session: {} }, LOGIN);
        expect(result).toBeNull();
    });
});
