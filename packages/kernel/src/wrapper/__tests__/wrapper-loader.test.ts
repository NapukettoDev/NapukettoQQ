// biome-ignore-all lint/style/useNamingConvention: 对象键名为 QQ wrapper.node 真实导出名（PascalCase），必须原样保留
/**
 * wrapper-loader.ts 基线测试（fallow 重构目标，untested risk）
 *
 * 覆盖 createWrapper / createSession / initEngine / startSession /
 * resolveQqUserDataRoot / defaultEngineConfig 等引导路径，用 mock exports
 * 对象模拟 QQ 环境，不依赖真实 wrapper.node。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NodeIQQNTWrapperSession, WrapperNodeApi } from "../../types/index.js";
import { PlatformType } from "../../types/index.js";
import type { WrapperContext } from "../wrapper-loader.js";
import {
    createSession,
    createWrapper,
    electronProcessType,
    initEngine,
    resolveQqUserDataRoot,
    startSession,
} from "../wrapper-loader.js";
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

describe("initEngine", () => {
    it("调用 initWithDeskTopConfig", () => {
        const exports = mockExports();
        const ctx = makeCtx(exports);
        initEngine(ctx, {
            base_path_prefix: "",
            platform_type: 1,
            app_type: 4,
            app_version: "",
            os_version: "win32",
            use_xlog: false,
            qua: "",
            global_path_config: { desktopGlobalPath: "" },
            thumb_config: { maxSide: 324, minSide: 48, longLimit: 6, density: 2 },
        });
        const engine = ctx.engine as unknown as {
            initWithDeskTopConfig: ReturnType<typeof vi.fn>;
        };
        expect(engine.initWithDeskTopConfig).toHaveBeenCalled();
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

    it("Linux：未显式传数据根时读 NAPUTO_DATA_ROOT", () => {
        vi.stubEnv("NAPUTO_DATA_ROOT", "/env/napuketto");
        const exports = mockExports({
            NodeQQNTWrapperUtil: { get: () => ({ getNTUserDataInfoConfig: () => null }) },
        });
        expect(resolveQqUserDataRoot(exports, { platform: PlatformType.KLINUX })).toBe(
            "/env/napuketto",
        );
    });

    it("Linux：数据根缺失时回退 QQ 官方 API", () => {
        vi.stubEnv("NAPUTO_DATA_ROOT", "");
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

describe("electronProcessType", () => {
    it("标准 node 下返回 undefined", () => {
        expect(electronProcessType()).toBeUndefined();
    });
});
