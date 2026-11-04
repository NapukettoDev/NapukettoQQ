// biome-ignore-all lint/style/useNamingConvention: 对象键名为 QQ wrapper.node 真实导出名（PascalCase），必须原样保留
/**
 * wrapper-loader.ts startNapuketto 装配链测试（基线之外）：
 *  - 自建宿主（process.type undefined）：session 先于 engine 创建（顺序决定性）
 *  - QQ 主进程（type=browser 模拟）：session 在 engine 后创建
 *  - 捕获 session（boot.cjs 拦截 new）→ 不重复创建
 *  - sessionConfig 提供时 initSession + startSession（startupSession.start 优先）
 *  - loginService 解析：捕获实例 > 单例 get() > new 回退 > 全失败 null
 *  - engine 配置：显式覆盖优先，缺省走默认（desktopGlobalPath 解析）
 */
import { describe, expect, it, vi } from "vitest";
import type {
    EnginInitDesktopConfig,
    NodeIQQNTWrapperSession,
    NodeIQQNTWrapperSessionCtor,
    WrapperNodeApi,
    WrapperSessionInitConfig,
} from "../../types/index.js";
import { PlatformType } from "../../types/index.js";
import { makeCtx, mockExports, sessionCtorMock } from "../test-support.js";
import {
    createSession,
    electronProcessType,
    startNapuketto,
    type WrapperContext,
} from "../wrapper-loader.js";

/** 模拟 Electron 进程类型（进程内 process.type 属性注入，用后恢复）。 */
function withProcessType(type: string | undefined, fn: () => void): void {
    const p = process as unknown as { type?: string };
    const saved = p.type;
    if (type === undefined) {
        delete p.type;
    } else {
        p.type = type;
    }
    try {
        fn();
    } finally {
        if (saved === undefined) {
            delete p.type;
        } else {
            p.type = saved;
        }
    }
}

describe("startNapuketto 自建宿主（无 process.type）", () => {
    it("session 先于 engine 创建（自建宿主决定性顺序）", () => {
        withProcessType(undefined, () => {
            const order: string[] = [];
            const session = { startNT: vi.fn(() => order.push("startNT")) };
            const engine = {
                initWithDeskTopConfig: vi.fn(() => order.push("engine")),
            };
            const exports = mockExports({
                NodeIQQNTWrapperEngine: { get: () => engine },
                NodeIQQNTWrapperSession: sessionCtorMock(session),
                NodeIQQNTStartupSessionWrapper: {
                    create: () => {
                        order.push("ssw.create");
                        return { start: vi.fn() };
                    },
                },
            });
            const ctx = startNapuketto({
                wrapperExports: exports,
                env: { qqVersion: "9.9.33-52230" },
            });
            expect(order).toEqual(["ssw.create", "engine"]);
            expect(ctx.session).toBe(session);
            expect(ctx.versionInfo.fullVersion).toBe("9.9.33-52230");
        });
    });

    it("默认 engine 配置：QQ 版本 / KWINDOWS / desktopGlobalPath 解析（getNTUserDataInfoConfig null → 用户目录兜底）", () => {
        withProcessType(undefined, () => {
            const engine = { initWithDeskTopConfig: vi.fn() };
            const exports = mockExports({
                NodeIQQNTWrapperEngine: { get: () => engine },
            });
            startNapuketto({
                wrapperExports: exports,
                env: { qqVersion: "9.9.33-52230", dataDir: "D:/data" },
            });
            const config = engine.initWithDeskTopConfig.mock.calls[0]?.[0] as Record<
                string,
                unknown
            >;
            expect(config["app_version"]).toBe("9.9.33-52230");
            expect(config["app_type"]).toBe(4);
            expect(config["use_xlog"]).toBe(false);
            const globalPath = (config["global_path_config"] as Record<string, unknown>)[
                "desktopGlobalPath"
            ] as string;
            expect(globalPath).toContain("nt_qq");
            expect(globalPath).toContain("global");
        });
    });

    it("显式 engineConfig 覆盖默认配置", () => {
        withProcessType(undefined, () => {
            const engine = { initWithDeskTopConfig: vi.fn() };
            const exports = mockExports({
                NodeIQQNTWrapperEngine: { get: () => engine },
            });
            const custom: EnginInitDesktopConfig = {
                base_path_prefix: "",
                platform_type: PlatformType.KWINDOWS,
                app_type: 4,
                app_version: "custom",
                os_version: "os",
                use_xlog: true,
                qua: "q",
                global_path_config: { desktopGlobalPath: "gp" },
                thumb_config: { maxSide: 324, minSide: 48, longLimit: 6, density: 2 },
            };
            startNapuketto({ wrapperExports: exports, engineConfig: custom });
            expect(engine.initWithDeskTopConfig).toHaveBeenCalledWith(custom, expect.anything());
        });
    });

    it("qqSession 捕获 → 不重复创建 session", () => {
        withProcessType(undefined, () => {
            const captured = { startNT: vi.fn() } as unknown as NodeIQQNTWrapperSession;
            const ctor = sessionCtorMock({});
            const exports = mockExports({ NodeIQQNTWrapperSession: ctor });
            const ctx = startNapuketto({ wrapperExports: exports, qqSession: captured });
            expect(ctx.session).toBe(captured);
            expect(ctor).not.toHaveBeenCalled();
        });
    });

    it("sessionConfig 提供 → initSession + startSession（startupSession.start）", () => {
        withProcessType(undefined, () => {
            const start = vi.fn();
            const session = { init: vi.fn(), startNT: vi.fn() };
            const exports = mockExports({
                NodeIQQNTWrapperSession: sessionCtorMock(session),
                NodeIQQNTStartupSessionWrapper: { create: () => ({ start }) },
            });
            const sessionConfig = {
                selfUin: "10001",
                selfUid: "u1",
            } as unknown as WrapperSessionInitConfig;
            startNapuketto({ wrapperExports: exports, sessionConfig });
            expect(session.init).toHaveBeenCalledTimes(1);
            expect(start).toHaveBeenCalledTimes(1);
            expect(session.startNT).not.toHaveBeenCalled();
        });
    });

    it("loginService：捕获实例优先", () => {
        withProcessType(undefined, () => {
            const captured = { uin: "1" };
            const ctx = startNapuketto({
                wrapperExports: mockExports(),
                qqLoginService: captured,
            });
            expect(ctx.loginService).toBe(captured);
        });
    });

    it("loginService：无捕获时单例 get()；缺 get 方法回退 new；get 抛错 → null", () => {
        withProcessType(undefined, () => {
            const singleton = { uin: "2" };
            const ctx1 = startNapuketto({
                wrapperExports: mockExports({ NodeIKernelLoginService: { get: () => singleton } }),
            });
            expect(ctx1.loginService).toBe(singleton);

            // get() 返回 null 时 loginService 即 null（get 存在则不再回退 new）
            const ctxNull = startNapuketto({
                wrapperExports: mockExports({ NodeIKernelLoginService: { get: () => null } }),
            });
            expect(ctxNull.loginService).toBeNull();

            // 无 get 方法（老 exports）→ new 回退
            const Ctor = vi.fn(function (this: unknown) {
                return { uin: "3" };
            });
            const ctx2 = startNapuketto({
                wrapperExports: mockExports({ NodeIKernelLoginService: Ctor }),
            });
            expect(ctx2.loginService).toEqual({ uin: "3" });

            const ctx3 = startNapuketto({
                wrapperExports: mockExports({
                    NodeIKernelLoginService: {
                        get: () => {
                            throw new Error("get boom");
                        },
                    },
                }),
            });
            expect(ctx3.loginService).toBeNull();
        });
    });
});

describe("startNapuketto QQ 主进程（type=browser 模拟）", () => {
    it("session 在 engine 之后创建（browser 原顺序）", () => {
        withProcessType("browser", () => {
            const order: string[] = [];
            const session = { startNT: vi.fn() } as unknown as NodeIQQNTWrapperSession;
            // create 打点：createNewSession 调用发生在 engine 之后（finishSession）
            const ctor = Object.assign(
                vi.fn(() => session),
                {
                    get: () => null,
                    getNTWrapperSession: () => null,
                    create: () => {
                        order.push("session");
                        return session;
                    },
                },
            );
            const engine = {
                initWithDeskTopConfig: vi.fn(() => order.push("engine")),
            };
            const exports = mockExports({
                NodeIQQNTWrapperEngine: { get: () => engine },
                NodeIQQNTWrapperSession: ctor,
            });
            const ctx = startNapuketto({ wrapperExports: exports });
            expect(order).toEqual(["engine", "session"]);
            expect(ctx.session).toBe(session);
        });
    });

    it("browser 下 desktopGlobalPath 不解析（QQ 自己已配置 engine）", () => {
        withProcessType("browser", () => {
            const engine = { initWithDeskTopConfig: vi.fn() };
            const exports = mockExports({
                NodeIQQNTWrapperEngine: { get: () => engine },
            });
            startNapuketto({ wrapperExports: exports, env: { qqVersion: "v", dataDir: "D:/x" } });
            const config = engine.initWithDeskTopConfig.mock.calls[0]?.[0] as Record<
                string,
                unknown
            >;
            expect(
                (config["global_path_config"] as Record<string, unknown>)["desktopGlobalPath"],
            ).toBe("D:/x");
        });
    });
});

describe("导出补充", () => {
    it("electronProcessType：注入 browser 后返回 browser", () => {
        withProcessType("browser", () => {
            expect(electronProcessType()).toBe("browser");
        });
    });

    it("createSession：startupSession 记录到 ctx（SSW.create 成功路径）", () => {
        const ssw = { start: vi.fn() };
        const exports = mockExports({
            NodeIQQNTStartupSessionWrapper: { create: () => ssw },
        });
        const ctx: WrapperContext = makeCtx(exports as WrapperNodeApi);
        const session = createSession(ctx);
        expect(ctx.startupSession).toBe(ssw);
        expect(ctx.session).toBe(session);
    });

    it("createSession：无 SSW 导出 → 跳过 startup 链（session 由 getNTWrapperSession/create 兜底）", () => {
        const exports = mockExports({});
        delete (exports as unknown as Record<string, unknown>)["NodeIQQNTStartupSessionWrapper"];
        const ctx: WrapperContext = makeCtx(exports);
        expect(createSession(ctx)).toBeDefined();
        expect(ctx.startupSession).toBeNull();
    });

    it("createSession：getNTWrapperSession 与 create 都缺失 → new S() 兜底", () => {
        // 普通函数构造器（new S() 返回空对象，模拟 wrapper 构造行为）
        const sessionCtor = Object.assign(
            function sessionCtor(this: unknown) {
                return {};
            },
            { get: () => null },
        ) as unknown as NodeIQQNTWrapperSessionCtor;
        const exports = mockExports({ NodeIQQNTWrapperSession: sessionCtor });
        const ctx: WrapperContext = makeCtx(exports);
        expect(createSession(ctx)).toBeDefined();
    });

    it("createSession：getNTWrapperSession 抛错 → 回退链继续", () => {
        const sessionCtor = Object.assign(
            function sessionCtor(this: unknown) {
                return {};
            },
            {
                getNTWrapperSession: () => {
                    throw new Error("nt session unavailable");
                },
                create: () => null,
            },
        ) as unknown as NodeIQQNTWrapperSessionCtor;
        const exports = mockExports({ NodeIQQNTWrapperSession: sessionCtor });
        const ctx: WrapperContext = makeCtx(exports);
        expect(createSession(ctx)).toBeDefined();
    });

    it("createSession：S.create 抛错 → 回退 new S()", () => {
        const sessionCtor = Object.assign(
            function sessionCtor(this: unknown) {
                return { fromNew: true };
            },
            {
                getNTWrapperSession: () => null,
                create: () => {
                    throw new Error("create refused");
                },
            },
        ) as unknown as NodeIQQNTWrapperSessionCtor;
        const exports = mockExports({ NodeIQQNTWrapperSession: sessionCtor });
        const ctx: WrapperContext = makeCtx(exports);
        const session = createSession(ctx) as unknown as { fromNew?: boolean };
        expect(session.fromNew).toBe(true);
    });
});
