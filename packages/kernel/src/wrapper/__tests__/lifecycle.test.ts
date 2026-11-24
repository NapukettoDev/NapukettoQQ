// biome-ignore-all lint/style/useNamingConvention: 对象键名为 QQ wrapper.node 真实导出名（PascalCase），必须原样保留
/**
 * lifecycle.ts 基线测试（fallow 重构目标，untested risk）
 *
 * 覆盖 createWrapper / createSession / startSession / resolveQqUserDataRoot
 * 等引导路径，用 mock exports 对象模拟 QQ 环境，不依赖真实 wrapper.node。
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NodeIQQNTWrapperSession, WrapperNodeApi } from "../../types/index.js";
import { PlatformType } from "../../types/index.js";
import type { WrapperContext } from "../lifecycle.js";
import { createSession, createWrapper, initSession, startSession } from "../lifecycle.js";
import { resolveQqUserDataRoot } from "../loader.js";
import { makeCtx, mockExports, sessionCtorMock } from "./test-support.js";

describe("createWrapper", () => {
    it("exports 有效时返回完整上下文", () => {
        const ctx = createWrapper(mockExports(), {
            fullVersion: "9.9.31-49919",
            buildVersion: "49919",
        });
        expect(ctx.engine).toBeDefined();
        expect(ctx.session).toBeNull();
        expect(ctx.startupSession).toBeNull();
    });

    it("缺少 NodeIQQNTWrapperEngine 抛 INVALID_PARAM", () => {
        const bad = { NodeIQQNTWrapperEngine: null } as unknown as WrapperNodeApi;
        expect(() =>
            createWrapper(bad, { fullVersion: "9.9.31-49919", buildVersion: "49919" }),
        ).toThrow(/wrapper.node exports 无效/);
    });

    it("engine.get() 返回无效对象抛 INVALID_PARAM", () => {
        const bad = {
            NodeIQQNTWrapperEngine: { get: () => ({}) },
        } as unknown as WrapperNodeApi;
        expect(() =>
            createWrapper(bad, { fullVersion: "9.9.31-49919", buildVersion: "49919" }),
        ).toThrow(/NodeIQQNTWrapperEngine.get\(\) 返回对象无效/);
    });
});

describe("createSession", () => {
    it("回退链：create 兜底", () => {
        const fallbackSession = { getMsgService: vi.fn() };
        const exports = mockExports({
            NodeIQQNTWrapperSession: sessionCtorMock(fallbackSession),
        });
        const ctx = makeCtx(exports);
        const session = createSession(ctx);
        expect(session).toBe(fallbackSession);
        expect(ctx.session).toBe(session);
    });

    it("getNTWrapperSession 命中优先", () => {
        const fake = { getMsgService: vi.fn() };
        const exports = mockExports({
            NodeIQQNTWrapperSession: {
                get: () => null,
                getNTWrapperSession: () => fake,
                create: () => null,
            },
        });
        const ctx = makeCtx(exports);
        const session = createSession(ctx);
        expect(session).toBe(fake);
    });

    it("Session 构造器缺失/非函数 → KernelError（不裸 new）", () => {
        const exports = mockExports({ NodeIQQNTWrapperSession: undefined });
        const ctx = makeCtx(exports);
        expect(() => createSession(ctx)).toThrow(/缺少可调用的 NodeIQQNTWrapperSession 构造器/);
    });

    it("create() 返回空壳对象 → 视为不可用，继续回退 new", () => {
        const fallbackSession = { getMsgService: vi.fn() };
        function ConstructibleSessionCtor(this: unknown) {
            return fallbackSession;
        }
        Object.assign(ConstructibleSessionCtor, {
            get: () => null,
            getNTWrapperSession: () => null,
            create: () => ({ notASession: true }),
        });
        const exports = mockExports({ NodeIQQNTWrapperSession: ConstructibleSessionCtor });
        const ctx = makeCtx(exports);
        expect(() => createSession(ctx)).not.toThrow();
        expect(ctx.session).toBe(fallbackSession);
    });

    it("startupSession.create 失败不中断", () => {
        const fallbackSession = { getMsgService: vi.fn() };
        const exports = mockExports({
            NodeIQQNTStartupSessionWrapper: {
                create: () => {
                    throw new Error("boom");
                },
            },
            NodeIQQNTWrapperSession: sessionCtorMock(fallbackSession),
        });
        const ctx = makeCtx(exports);
        expect(() => createSession(ctx)).not.toThrow();
        expect(ctx.session).not.toBeNull();
    });
});

describe("initSession", () => {
    it("session 缺 init → INVALID_STATE（空壳 Session 不裸调）", () => {
        const ctx = makeCtx(mockExports());
        ctx.session = { getMsgService: vi.fn() } as unknown as NodeIQQNTWrapperSession;
        expect(() => initSession(ctx, {} as never, {} as never)).toThrow(/缺少 init 方法/);
    });

    it("session 具备 init → 正常调用", () => {
        const init = vi.fn();
        const ctx = makeCtx(mockExports());
        ctx.session = { init, getMsgService: vi.fn() } as unknown as NodeIQQNTWrapperSession;
        initSession(ctx, {} as never, {} as never);
        expect(init).toHaveBeenCalledTimes(1);
    });
});

describe("startSession", () => {
    it("无 session 抛 INVALID_STATE", () => {
        const ctx = makeCtx(mockExports());
        expect(() => startSession(ctx)).toThrow(/session 未创建/);
    });

    it("startupSession 存在时用 start()", () => {
        const start = vi.fn();
        const ctx = makeCtx(mockExports());
        ctx.session = { startNT: vi.fn() } as unknown as NodeIQQNTWrapperSession;
        ctx.startupSession = { start } as unknown as WrapperContext["startupSession"];
        startSession(ctx);
        expect(start).toHaveBeenCalled();
    });

    it("无 startupSession 时用 startNT(0)", () => {
        const startNT = vi.fn();
        const ctx = makeCtx(mockExports());
        ctx.session = { startNT } as unknown as NodeIQQNTWrapperSession;
        startSession(ctx);
        expect(startNT).toHaveBeenCalledWith(0);
    });
});

describe("resolveQqUserDataRoot", () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("Windows：QQ 官方 API 返回字符串时提取数据根", () => {
        const exports = mockExports({
            NodeQQNTWrapperUtil: {
                get: () => ({
                    getNTUserDataInfoConfig: () => "C:\\Users\\test\\Documents\\Tencent Files",
                }),
            },
        });
        expect(resolveQqUserDataRoot(exports, { platform: PlatformType.KWINDOWS })).toContain(
            "Tencent Files",
        );
    });

    it("Windows 沙箱：使用沙箱数据根且拒绝越界", () => {
        const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "napuketto-root-")));
        try {
            vi.stubEnv("NAPUKETTO_SANDBOX_ROOT", sandbox);
            const dataRoot = join(sandbox, ".napuketto");
            const getNTUserDataInfoConfig = vi.fn(
                () => "C:\\Users\\test\\Documents\\Tencent Files",
            );
            const exports = mockExports({
                NodeQQNTWrapperUtil: { get: () => ({ getNTUserDataInfoConfig }) },
            });
            const platform = PlatformType.KWINDOWS;
            expect(resolveQqUserDataRoot(exports, { dataRoot, platform })).toBe(dataRoot);
            expect(() =>
                resolveQqUserDataRoot(exports, { dataRoot: dirname(sandbox), platform }),
            ).toThrow("必须位于调试沙箱内");
            expect(getNTUserDataInfoConfig).not.toHaveBeenCalled();
        } finally {
            rmSync(sandbox, { recursive: true, force: true });
        }
    });

    it("Windows：API 不可用时回退默认位置", () => {
        const exports = mockExports({
            NodeQQNTWrapperUtil: { get: () => ({ getNTUserDataInfoConfig: () => null }) },
        });
        const result = resolveQqUserDataRoot(exports, { platform: PlatformType.KWINDOWS });
        expect(result).toContain("Tencent Files");
    });

    it("Windows：API 抛异常时回退默认位置", () => {
        const exports = mockExports({
            NodeQQNTWrapperUtil: {
                get: () => {
                    throw new Error("boom");
                },
            },
        });
        const result = resolveQqUserDataRoot(exports, { platform: PlatformType.KWINDOWS });
        expect(result).toContain("Tencent Files");
    });

    it("Linux：显式数据根优先，不读 QQ 官方 API", () => {
        const getNTUserDataInfoConfig = vi.fn(() => "/home/test/Documents/Tencent Files");
        const exports = mockExports({
            NodeQQNTWrapperUtil: { get: () => ({ getNTUserDataInfoConfig }) },
        });
        const result = resolveQqUserDataRoot(exports, {
            platform: PlatformType.KLINUX,
            dataRoot: "/data/napuketto",
        });
        expect(result).toBe("/data/napuketto");
        expect(getNTUserDataInfoConfig).not.toHaveBeenCalled();
    });

    it("Linux：未显式传数据根时读 NAPUKETTO_DATA_ROOT", () => {
        vi.stubEnv("NAPUKETTO_DATA_ROOT", "/env/napuketto");
        const exports = mockExports({
            NodeQQNTWrapperUtil: { get: () => ({ getNTUserDataInfoConfig: () => null }) },
        });
        expect(resolveQqUserDataRoot(exports, { platform: PlatformType.KLINUX })).toBe(
            "/env/napuketto",
        );
    });

    it("Linux：数据根缺失时回退 QQ 官方 API", () => {
        vi.stubEnv("NAPUKETTO_DATA_ROOT", "");
        const exports = mockExports({
            NodeQQNTWrapperUtil: {
                get: () => ({
                    getNTUserDataInfoConfig: () => "/home/test/Documents/Tencent Files",
                }),
            },
        });
        expect(resolveQqUserDataRoot(exports, { platform: PlatformType.KLINUX })).toBe(
            "/home/test/Documents/Tencent Files",
        );
    });

    it("Windows：忽略 dataRoot（仍走 QQ 官方 API）", () => {
        const exports = mockExports({
            NodeQQNTWrapperUtil: {
                get: () => ({
                    getNTUserDataInfoConfig: () => "C:\\Users\\test\\Documents\\Tencent Files",
                }),
            },
        });
        const result = resolveQqUserDataRoot(exports, {
            platform: PlatformType.KWINDOWS,
            dataRoot: "/data/napuketto",
        });
        expect(result).toContain("Tencent Files");
    });
});
