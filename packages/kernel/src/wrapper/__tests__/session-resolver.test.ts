// biome-ignore-all lint/style/useNamingConvention: 对象键名为 QQ wrapper.node 真实导出名（PascalCase），必须原样保留
/**
 * session-resolver.ts 基线测试（fallow 重构目标，untested risk）
 *
 * 覆盖 getExistingSession / getMainSession 及内部链路：
 *  - get() 单例命中 / 无效回退
 *  - startup.create → start → getSessionIdList → getNTWrapperSession 链路
 *  - findMainSessionId 的 nt_ 前缀优先 / 任意字符串兜底
 */
import { describe, expect, it, vi } from "vitest";
import type { NodeIQQNTWrapperSession } from "../../types/index.js";
import { getExistingSession, getMainSession } from "../session-resolver.js";
import type { WrapperContext } from "../wrapper-loader.js";

/** 构造 ctx（session ctor 与 startup ctor 由测试注入）。 */
function makeCtx(exports: WrapperContext["exports"]): WrapperContext {
    return {
        exports,
        engine: {} as WrapperContext["engine"],
        versionInfo: { fullVersion: "9.9.31-49919", buildVersion: "49919" },
        session: null,
        startupSession: null,
        loginService: null,
    };
}

/** 假 session（带 getMsgService）。 */
function fakeSession(): NodeIQQNTWrapperSession {
    return { getMsgService: vi.fn() } as unknown as NodeIQQNTWrapperSession;
}

/** 仅含指定键的 exports（宽松断言，测试注入用）。 */
function partialExports(partial: object): WrapperContext["exports"] {
    return partial as unknown as WrapperContext["exports"];
}

describe("getExistingSession", () => {
    it("get() 命中时复用并写入 ctx.session", () => {
        const session = fakeSession();
        const ctx = makeCtx(
            partialExports({
                NodeIQQNTWrapperSession: { get: () => session },
            }),
        );
        expect(getExistingSession(ctx)).toBe(session);
        expect(ctx.session).toBe(session);
    });

    it("get() 无效对象返回 null", () => {
        const ctx = makeCtx(
            partialExports({
                NodeIQQNTWrapperSession: { get: () => ({}) },
            }),
        );
        expect(getExistingSession(ctx)).toBeNull();
    });

    it("无 get() 方法返回 null", () => {
        const ctx = makeCtx(
            partialExports({
                NodeIQQNTWrapperSession: {},
            }),
        );
        expect(getExistingSession(ctx)).toBeNull();
    });

    it("get() 抛异常返回 null", () => {
        const ctx = makeCtx(
            partialExports({
                NodeIQQNTWrapperSession: {
                    get: () => {
                        throw new Error("boom");
                    },
                },
            }),
        );
        expect(getExistingSession(ctx)).toBeNull();
    });
});

describe("getMainSession", () => {
    it("startup 链路完整时返回主 session 并写 ctx.session", () => {
        const session = fakeSession();
        const ctx = makeCtx(
            partialExports({
                NodeIQQNTStartupSessionWrapper: {
                    create: () => ({
                        start: vi.fn(),
                        getSessionIdList: () =>
                            new Map([
                                ["nt", "nt_3"],
                                ["gpro", "gpro_3"],
                            ]),
                    }),
                },
                NodeIQQNTWrapperSession: {
                    getNTWrapperSession: (id: string) => (id === "nt_3" ? session : null),
                },
            }),
        );
        expect(getMainSession(ctx)).toBe(session);
        expect(ctx.session).toBe(session);
    });

    it("getSessionIdList 非 Map 返回 null", () => {
        const ctx = makeCtx(
            partialExports({
                NodeIQQNTStartupSessionWrapper: {
                    create: () => ({
                        start: vi.fn(),
                        getSessionIdList: () => "not-a-map",
                    }),
                },
                NodeIQQNTWrapperSession: { getNTWrapperSession: () => null },
            }),
        );
        expect(getMainSession(ctx)).toBeNull();
    });

    it("缺 startup.create 返回 null", () => {
        const ctx = makeCtx(
            partialExports({
                NodeIQQNTStartupSessionWrapper: {},
                NodeIQQNTWrapperSession: { getNTWrapperSession: () => null },
            }),
        );
        expect(getMainSession(ctx)).toBeNull();
    });

    it("startup 链路抛异常返回 null", () => {
        const ctx = makeCtx(
            partialExports({
                NodeIQQNTStartupSessionWrapper: {
                    create: () => {
                        throw new Error("boom");
                    },
                },
                NodeIQQNTWrapperSession: { getNTWrapperSession: () => null },
            }),
        );
        expect(getMainSession(ctx)).toBeNull();
    });

    it("无 nt_ 前缀时取第一个字符串 id", () => {
        const session = fakeSession();
        const ctx = makeCtx(
            partialExports({
                NodeIQQNTStartupSessionWrapper: {
                    create: () => ({
                        start: vi.fn(),
                        getSessionIdList: () => new Map([["gpro", "gpro_0"]]),
                    }),
                },
                NodeIQQNTWrapperSession: { getNTWrapperSession: () => session },
            }),
        );
        expect(getMainSession(ctx)).toBe(session);
    });

    it("getNTWrapperSession 返回空壳（无 getMsgService）返回 null", () => {
        const ctx = makeCtx(
            partialExports({
                NodeIQQNTStartupSessionWrapper: {
                    create: () => ({
                        start: vi.fn(),
                        getSessionIdList: () => new Map([["nt", "nt_0"]]),
                    }),
                },
                NodeIQQNTWrapperSession: { getNTWrapperSession: () => ({}) },
            }),
        );
        expect(getMainSession(ctx)).toBeNull();
    });
});

describe("getSessionIdList 边界形态", () => {
    it("created 无 getSessionIdList 方法 → null（不再取 session）", () => {
        const created = { start: vi.fn() };
        const ctx = makeCtx(
            partialExports({
                NodeIQQNTStartupSessionWrapper: { create: () => created },
                NodeIQQNTWrapperSession: { getNTWrapperSession: () => fakeSession() },
            }),
        );
        expect(getMainSession(ctx)).toBeNull();
        expect(created.start).toHaveBeenCalledOnce();
        expect(ctx.session).toBeNull();
    });

    it("sessionIdList 值非字符串（数字值 + 字符串键）→ 退化取键名", () => {
        const created = {
            start: vi.fn(),
            getSessionIdList: () => new Map<unknown, unknown>([["nt_5", 123]]),
        };
        const getNT = vi.fn((_id: string) => fakeSession());
        const ctx = makeCtx(
            partialExports({
                NodeIQQNTStartupSessionWrapper: { create: () => created },
                NodeIQQNTWrapperSession: { getNTWrapperSession: getNT },
            }),
        );
        expect(getMainSession(ctx)).not.toBeNull();
        expect(getNT.mock.calls[0]?.[0]).toBe("nt_5");
    });

    it("Map 键为非字符串（数字键 + 字符串值匹配失败）→ 取第一个字符串值/键兜底", () => {
        const created = {
            start: vi.fn(),
            getSessionIdList: () => new Map<unknown, unknown>([[7, "nt_7"]]),
        };
        const ctx = makeCtx(
            partialExports({
                NodeIQQNTStartupSessionWrapper: { create: () => created },
                NodeIQQNTWrapperSession: {
                    getNTWrapperSession: vi.fn(() => fakeSession()),
                },
            }),
        );
        expect(getMainSession(ctx)).not.toBeNull();
    });

    it("Map 全为非字符串键值 → 找不到主 id 返回 null", () => {
        const created = {
            start: vi.fn(),
            getSessionIdList: () => new Map<unknown, unknown>([[7, 8]]),
        };
        const ctx = makeCtx(
            partialExports({
                NodeIQQNTStartupSessionWrapper: { create: () => created },
                NodeIQQNTWrapperSession: {
                    getNTWrapperSession: vi.fn(() => fakeSession()),
                },
            }),
        );
        expect(getMainSession(ctx)).toBeNull();
    });
});
