/**
 * session-activation.test.ts：session.ts 登录后编排单测（P2 拆分自 bootstrap/core-phases）。
 *
 * 直接针对 session.ts 导出（不经 bootstrapWithCore）：
 *  - replaceSession：非自建宿主候选替换 / 同 session / 无候选 / 自建宿主恒 null
 *  - activateSession：先 init 后 start（buildSessionConfig 三要素）/ 候选优先 /
 *    READY 跳过 / init 失败容错
 *  - waitSessionReady：成功（30s 超时参数）/ 失败容错
 *  - probeCreatedSession：create() 抛错日志留痕（原 bootstrap 集成用例下沉）
 *
 * env 快照每用例独立（stubEnv + resetModules + 动态 import）；shared/boot-log 的 log
 * 经 vi.mock 收集，其余导出透传真实实现。
 */

import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SharedState } from "../../../src/host/runtime/state.js";
import type {
    BootstrapEnv,
    CoreContextLike,
    CoreLike,
    KernelLike,
    LoginResultLike,
} from "../../../src/host/runtime/types.js";

/** log 收集器（session.ts 的探测/激活日志可断言）。 */
const h = vi.hoisted(() => {
    return { logs: [] as string[] };
});

vi.mock("../../../src/shared/boot-log.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../src/shared/boot-log.js")>();
    return {
        ...actual,
        log: (msg: string) => {
            h.logs.push(msg);
        },
    };
});

const BOOT_ENV: BootstrapEnv = {
    qqVersion: "9.9.9-Test",
    dataDir: "数据目录",
    dataRoot: "",
    wrapperPath: "wrapper.node",
};
const LOGIN: LoginResultLike = { uin: "10001", uid: "u1", nick: "甲" };
const APPID = 537376818;

beforeEach(() => {
    h.logs.length = 0;
    vi.unstubAllEnvs();
});

afterEach(() => {
    vi.unstubAllEnvs();
});

/** 取全新 session 模块（env 快照隔离：NAPUKETTO_SELF_HOST 每用例可变）。 */
async function freshSession(): Promise<typeof import("../../../src/host/auth/session.js")> {
    vi.resetModules();
    return await import("../../../src/host/auth/session.js");
}

/** 空共享状态。 */
function freshState(overrides: Partial<SharedState> = {}): SharedState {
    return {
        wrapperExports: null,
        qqSession: null,
        qqLoginService: null,
        bootstrapped: false,
        ...overrides,
    };
}

/** 最小 ctx。 */
function freshCtx(overrides: Partial<CoreContextLike> = {}): CoreContextLike {
    return { session: {}, ...overrides };
}

/** 假 core（replaceSession 只需 setSession）。 */
function fakeCore(): { core: CoreLike; setSession: ReturnType<typeof vi.fn> } {
    const setSession = vi.fn();
    return { core: { setSession } as unknown as CoreLike, setSession };
}

/** activateSession 假 kernel 的调用记录。 */
interface ActivateCalls {
    /** buildSessionConfig 收到的参数。 */
    sessionConfig: Record<string, unknown>[];
    /** initAndStartSession 调用。 */
    init: Array<{
        ctx: CoreContextLike;
        config: unknown;
        listener: unknown;
        timeoutMs: number;
    }>;
    /** resolveQqUserDataRoot 调用。 */
    resolveRoot: Array<{
        wrapperExports: unknown;
        options: { dataRoot?: string } | undefined;
    }>;
    /** resolveQqGlobalPath 收到的数据根。 */
    resolveGlobal: string[];
    /** readMachineGuid 收到的 loginService。 */
    machineGuid: unknown[];
    /** createLifecycleSessionListener 调用次数。 */
    listener: number;
}

/** 假 kernel：activateSession 全部依赖面（可注入 init 失败）。 */
function fakeActivateKernel(options: { initError?: Error } = {}): {
    kernel: KernelLike;
    calls: ActivateCalls;
} {
    const calls: ActivateCalls = {
        sessionConfig: [],
        init: [],
        resolveRoot: [],
        resolveGlobal: [],
        machineGuid: [],
        listener: 0,
    };
    const kernel = {
        resolveQqUserDataRoot: (
            wrapperExports: unknown,
            resolveOptions?: { dataRoot?: string },
        ) => {
            calls.resolveRoot.push({ wrapperExports, options: resolveOptions });
            return "qqroot";
        },
        resolveQqGlobalPath: (root: string) => {
            calls.resolveGlobal.push(root);
            return `${root}/global`;
        },
        readMachineGuid: (loginService: unknown) => {
            calls.machineGuid.push(loginService);
            return "machine-guid";
        },
        buildSessionConfig: (args: Record<string, unknown>) => {
            calls.sessionConfig.push(args);
            return { built: true };
        },
        createLifecycleSessionListener: () => {
            calls.listener += 1;
            return { listener: true };
        },
        initAndStartSession: async (
            ctx: CoreContextLike,
            config: unknown,
            listener: unknown,
            initOptions: { timeoutMs: number },
        ) => {
            calls.init.push({
                ctx,
                config,
                listener,
                timeoutMs: initOptions.timeoutMs,
            });
            if (options.initError !== undefined) {
                throw options.initError;
            }
        },
    };
    return { kernel: kernel as unknown as KernelLike, calls };
}

describe("replaceSession", () => {
    it("非自建宿主：READY 主 session 候选 → core.setSession 替换", async () => {
        const mainSession = { getMsgService: () => ({}) };
        const ctx = freshCtx({ session: { getMsgService: () => null } });
        const { core, setSession } = fakeCore();
        const kernel = { getMainSession: () => mainSession } as unknown as KernelLike;
        const session = await freshSession();

        const chosen = session.replaceSession(kernel, core, freshState(), ctx);

        expect(chosen?.s).toBe(mainSession);
        expect(chosen?.tag).toBe("getMainSession(nt_x)");
        expect(setSession).toHaveBeenCalledWith(mainSession);
        expect(h.logs).toContain(
            "bootstrap: 已替换 session（来源=getMainSession(nt_x)，msgSvc=READY）",
        );
    });

    it("候选与 ctx.session 相同 → 不替换（原地保留）", async () => {
        const ctxSession = { getMsgService: () => ({}) };
        const ctx = freshCtx({ session: ctxSession });
        const { core, setSession } = fakeCore();
        const kernel = { getMainSession: () => ctxSession } as unknown as KernelLike;
        const session = await freshSession();

        const chosen = session.replaceSession(kernel, core, freshState(), ctx);

        expect(chosen?.s).toBe(ctxSession);
        expect(setSession).not.toHaveBeenCalled();
        expect(h.logs).toContain(
            "bootstrap: 候选 session 与 ctx.session 相同（getMainSession(nt_x)）",
        );
    });

    it("无候选（getMainSession 抛错）→ 保留 kernel 自建 session", async () => {
        const { core, setSession } = fakeCore();
        const kernel = {
            getMainSession: () => {
                throw new Error("主 session 不可用");
            },
        } as unknown as KernelLike;
        const session = await freshSession();

        const chosen = session.replaceSession(kernel, core, freshState(), freshCtx());

        expect(chosen).toBeNull();
        expect(setSession).not.toHaveBeenCalled();
        expect(h.logs).toContain("bootstrap: getMainSession 失败: 主 session 不可用");
        expect(h.logs).toContain("bootstrap: 无有效候选 session（保留 kernel 自建 session）");
    });

    it("NAPUKETTO_SELF_HOST=1 → 恒 null 且不收集候选", async () => {
        vi.stubEnv("NAPUKETTO_SELF_HOST", "1");
        const getMainSession = vi.fn(() => ({ getMsgService: () => ({}) }));
        const { core, setSession } = fakeCore();
        const kernel = { getMainSession } as unknown as KernelLike;
        const state = freshState({
            // wrapper 导出面是 NAPI 原始类名（PascalCase 契约），用键值对构造
            wrapperExports: Object.fromEntries([
                ["NodeIQQNTWrapperSession", { get: () => ({ getMsgService: () => ({}) }) }],
            ]),
            qqSession: { getMsgService: () => ({}) },
        });
        const session = await freshSession();

        const chosen = session.replaceSession(kernel, core, state, freshCtx());

        expect(chosen).toBeNull();
        expect(getMainSession).not.toHaveBeenCalled();
        expect(setSession).not.toHaveBeenCalled();
        expect(h.logs).toHaveLength(0);
    });
});

describe("activateSession", () => {
    it("无候选（自建宿主）→ 以 ctx.session 为激活目标，三要素参数 + init 20s", async () => {
        const loginService = { getMachineGuid: () => "machine-guid" };
        const ctx = freshCtx({
            session: { getMsgService: () => null },
            loginService,
        });
        const state = freshState({ wrapperExports: { marker: true } });
        const bootEnv = { ...BOOT_ENV, dataRoot: "QQ数据根" };
        const { kernel, calls } = fakeActivateKernel();
        const session = await freshSession();

        await session.activateSession(kernel, state, ctx, null, LOGIN, APPID, bootEnv);

        expect(h.logs).toContain(
            "bootstrap: 激活 session（kernel 自建 session，先 init 后 startupSession.start）...",
        );
        // session 数据目录指向 QQ 真实数据根（resolveQqGlobalPath 的 global 目录）
        expect(calls.resolveRoot).toEqual([
            { wrapperExports: { marker: true }, options: { dataRoot: "QQ数据根" } },
        ]);
        expect(calls.resolveGlobal).toEqual(["qqroot"]);
        expect(calls.machineGuid).toEqual([loginService]);
        expect(calls.sessionConfig[0]).toMatchObject({
            appid: APPID,
            fullVersion: "9.9.9-Test",
            selfUin: "10001",
            selfUid: "u1",
            accountPath: "qqroot/global",
            machineGuid: "machine-guid",
        });
        expect(calls.sessionConfig[0]?.["downloadPath"]).toBe(
            join("qqroot/global", "NapCat", "temp"),
        );
        expect(calls.listener).toBe(1);
        expect(calls.init[0]).toEqual({
            ctx,
            config: { built: true },
            listener: { listener: true },
            timeoutMs: 20000,
        });
        expect(h.logs).toContain("bootstrap: 激活 session init + start 完成");
    });

    it("候选非 READY → 激活候选（tag 来源）而非 ctx.session", async () => {
        const ctx = freshCtx({ session: { getMsgService: () => ({}) } });
        const chosen = { s: { getMsgService: () => null }, tag: "getNT(Session)" };
        const { kernel, calls } = fakeActivateKernel();
        const session = await freshSession();

        await session.activateSession(kernel, freshState(), ctx, chosen, LOGIN, APPID, BOOT_ENV);

        expect(h.logs).toContain(
            "bootstrap: 激活 session（getNT(Session)，先 init 后 startupSession.start）...",
        );
        expect(calls.sessionConfig).toHaveLength(1);
        expect(calls.init).toHaveLength(1);
    });

    it("session 已 READY → 跳过 init/start（不构造会话配置）", async () => {
        const chosen = { s: { getMsgService: () => ({}) }, tag: "getMainSession(nt_x)" };
        const { kernel, calls } = fakeActivateKernel();
        const session = await freshSession();

        await session.activateSession(
            kernel,
            freshState(),
            freshCtx(),
            chosen,
            LOGIN,
            APPID,
            BOOT_ENV,
        );

        expect(calls.sessionConfig).toHaveLength(0);
        expect(calls.init).toHaveLength(0);
        expect(calls.listener).toBe(0);
        expect(h.logs).toHaveLength(0);
    });

    it("initAndStartSession 拒绝 → 容错日志，不抛出", async () => {
        const { kernel } = fakeActivateKernel({ initError: new Error("session init 断言") });
        const session = await freshSession();

        await expect(
            session.activateSession(
                kernel,
                freshState(),
                freshCtx({ session: { getMsgService: () => null } }),
                null,
                LOGIN,
                APPID,
                BOOT_ENV,
            ),
        ).resolves.toBeUndefined();
        expect(h.logs).toContain("bootstrap: 激活 session init 失败: session init 断言");
    });
});

describe("waitSessionReady", () => {
    it("成功 → waitSessionReady(ctx, 30s) + 就绪日志", async () => {
        const waitSessionReady = vi.fn(() => Promise.resolve());
        const kernel = { waitSessionReady } as unknown as KernelLike;
        const ctx = freshCtx();
        const session = await freshSession();

        await session.waitSessionReady(kernel, ctx);

        expect(waitSessionReady).toHaveBeenCalledWith(ctx, { timeoutMs: 30000 });
        expect(h.logs).toContain("bootstrap: QQ session 就绪（getMsgService 可用）");
    });

    it("等待就绪拒绝 → 容错日志，不抛出", async () => {
        const kernel = {
            waitSessionReady: () => Promise.reject(new Error("就绪超时")),
        } as unknown as KernelLike;
        const session = await freshSession();

        await expect(session.waitSessionReady(kernel, freshCtx())).resolves.toBeUndefined();
        expect(h.logs).toContain("bootstrap: 等待 session 就绪失败: 就绪超时");
    });
});

describe("probeCreatedSession", () => {
    it("S2.create() 抛错 → 探测失败日志留痕，不抛出", async () => {
        const state = freshState({
            wrapperExports: Object.fromEntries([
                [
                    "NodeIQQNTWrapperSession",
                    {
                        create: () => {
                            throw new Error("create 断言");
                        },
                    },
                ],
            ]),
        });
        const session = await freshSession();

        expect(() => session.probeCreatedSession(state, freshCtx())).not.toThrow();
        expect(h.logs).toContain("BOOT: create() 探测失败: create 断言");
    });
});
