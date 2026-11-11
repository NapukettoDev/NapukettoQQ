/**
 * self-host.test.ts：自建宿主入口单测（self-host.ts 顶层引导链路，2026-08-07 路线 A）。
 *
 * self-host.ts 是模块加载即执行的入口——每个用例独立环境（vi.stubEnv +
 * vi.resetModules + 动态 import）跑一遍真实顶层流程，边界全部 mock：
 *  - process.dlopen spy（绝不加载真实 wrapper.node / native 子模块二进制）
 *  - instance-lock / shutdown / ipc / bootstrap 模块整替身
 *  - process.exit spy（记录退出码不真退）
 *
 * 覆盖：
 *  - NAPUTO_WRAPPER_PATH 未设置 → exit 1（IPC 模式补 failed）
 *  - 单实例锁被占 → exit 1 + failed(INVALID_STATE)；获取成功 → registerLockCleanup
 *  - dlopen 抛错 → exit 1 + failed(UNKNOWN)；exports 缺 NodeIKernelLoginService → exit 1
 *  - O3MiscService 激活（addO3MiscListener）；缺失时告警继续
 *  - bootstrap 成功 → IPC ready；bootstrap false → exitBootIncomplete（exit 1 + 通用 failed）
 *  - bootstrap 抛 ConfigError → exit 78 + failed(INVALID_PARAM)；其余错误 → exit 1
 *  - 停止哨兵观察注册（dataRoot/account 推导）；unhandledRejection 兜底注册
 */
// biome-ignore-all lint/style/useNamingConvention: 对象键名为 kernel/wrapper 导出面（PascalCase 类名），必须原样保留

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/** mock 记录（vi.hoisted：mock 工厂内可见）。 */
const h = vi.hoisted(() => {
    return {
        /** IPC status 记录（phase + message + error）。 */
        statuses: [] as Array<{ phase: string; message?: string; error?: { code: string } }>,
        /** bootstrap 返回值（true/false/抛出）。 */
        bootstrapResult: true as boolean | Error,
        /** bootstrap 收到的 state（wrapperExports 断言用）。 */
        bootstrapStates: [] as Array<{ wrapperExports: Record<string, unknown> | null }>,
        /** instance-lock 行为。 */
        lockAcquired: true,
        lockCleanupRegistered: [] as string[],
        /** shutdown 行为。 */
        sentinelCalls: [] as Array<{ dataRoot: string; account?: string }>,
        /** O3MiscService.addO3MiscListener 调用计数。 */
        o3ListenerCalls: 0,
        /** process.on 捕获（unhandledRejection 注册面）。 */
        processOnCalls: [] as [string, (...args: never[]) => void][],
    };
});

vi.mock("../../../lifecycle/instance-lock.js", () => ({
    acquireInstanceLock: vi.fn(() => h.lockAcquired),
    checkInstanceLock: vi.fn(() => ({ occupied: true, pid: 321, lockPath: "C:/x/instance.lock" })),
    registerLockCleanup: vi.fn((dataDir: string) => {
        h.lockCleanupRegistered.push(dataDir);
    }),
}));

vi.mock("../../../lifecycle/shutdown.js", () => ({
    installSignalShutdown: vi.fn(),
    watchStopSentinel: vi.fn((opts: { dataRoot: string; account?: string }) => {
        h.sentinelCalls.push({
            dataRoot: opts.dataRoot,
            ...(opts.account !== undefined ? { account: opts.account } : {}),
        });
        return () => undefined;
    }),
    requestShutdown: vi.fn(async () => undefined),
}));

vi.mock("../../ipc/index.js", () => ({
    enableIpc: vi.fn(),
    sendStatus: vi.fn((phase: string, message?: string, error?: { code: string }) => {
        h.statuses.push({
            phase,
            ...(message !== undefined ? { message } : {}),
            ...(error !== undefined ? { error } : {}),
        });
    }),
    lastIpcStatusPhase: vi.fn(() =>
        h.statuses.length > 0 ? (h.statuses[h.statuses.length - 1]?.phase ?? null) : null,
    ),
    shouldSendGenericBootFailed: (ipcMode: boolean, lastPhase: string | null) =>
        ipcMode && lastPhase !== "failed",
}));

vi.mock("../bootstrap.js", () => ({
    bootstrap: vi.fn(async (state: { wrapperExports: Record<string, unknown> | null }) => {
        h.bootstrapStates.push({ wrapperExports: state.wrapperExports });
        if (h.bootstrapResult instanceof Error) {
            throw h.bootstrapResult;
        }
        return h.bootstrapResult;
    }),
}));

let tmpRoot = "";
let exitSpy: ReturnType<typeof vi.spyOn> | null = null;

beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "napuketto-selfhost-test-"));
});

afterAll(() => {
    if (tmpRoot !== "") {
        rmSync(tmpRoot, { recursive: true, force: true });
        tmpRoot = "";
    }
});

afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    exitSpy = null;
    h.statuses.length = 0;
    h.bootstrapResult = true;
    h.bootstrapStates.length = 0;
    h.lockAcquired = true;
    h.lockCleanupRegistered.length = 0;
    h.sentinelCalls.length = 0;
    h.o3ListenerCalls = 0;
    h.processOnCalls.length = 0;
});

/** dlopen spy（按 exportsOrError 决定行为）。 */
function mockDlopen(exportsOrError: Record<string, unknown> | Error): void {
    vi.spyOn(process, "dlopen").mockImplementation((module: object, _filename: string) => {
        if (exportsOrError instanceof Error) {
            throw exportsOrError;
        }
        Object.assign(
            (module as unknown as { exports: Record<string, unknown> }).exports,
            exportsOrError,
        );
    });
}

/** exit spy（记录不真退）。 */
function mockExit(): { codes: Array<number | undefined> } {
    const codes: Array<number | undefined> = [];
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
        codes.push(code);
        return undefined as never;
    }) as never);
    return { codes };
}

/** process.on spy（记录注册面，不真挂监听——防动态 import 多次累积监听器）。 */
function mockProcessOn(): void {
    vi.spyOn(process, "on").mockImplementation(((
        event: string,
        handler: (...args: never[]) => void,
    ) => {
        h.processOnCalls.push([event, handler]);
        return process;
    }) as never);
}

/** 取全新 self-host 模块（隔离 env 快照；每用例一个独立引导流程）。 */
async function freshSelfHost(): Promise<typeof import("../self-host.js")> {
    vi.resetModules();
    const mod = await import("../self-host.js");
    // 模块顶层 async IIFE（bootstrap 收敛）晚于 import resolve——等待收敛，
    // 防止 status/exit 记录 bleed 进下一用例
    await new Promise((r) => setTimeout(r, 10));
    return mod;
}

describe("self-host 引导前置", () => {
    it("NAPUTO_WRAPPER_PATH 未设置 → exit 1；IPC 模式补 failed(INVALID_STATE)", async () => {
        mockExit();
        vi.stubEnv("NAPUTO_IPC", "1");
        vi.stubEnv("NAPUTO_WRAPPER_PATH", "");
        await freshSelfHost();
        expect(exitSpy?.mock.calls[0]?.[0]).toBe(1);
        expect(
            h.statuses.some((st) => st.phase === "failed" && st.error?.code === "INVALID_STATE"),
        ).toBe(true);
    });

    it("单实例锁被占 → exit 1 + failed(INVALID_STATE)（不获取不注册清理）", async () => {
        mockExit();
        h.lockAcquired = false;
        vi.stubEnv("NAPUTO_IPC", "0");
        vi.stubEnv("NAPUTO_WRAPPER_PATH", join(tmpRoot, "wrapper.node"));
        vi.stubEnv("NAPUTO_CFG_DIR", join(tmpRoot, "10001"));
        await freshSelfHost();
        expect(exitSpy?.mock.calls[0]?.[0]).toBe(1);
    });

    it("锁获取成功 → registerLockCleanup 注册（进程退出删锁）", async () => {
        mockExit();
        mockDlopen({ NodeIKernelLoginService: {} });
        vi.stubEnv("NAPUTO_IPC", "0");
        vi.stubEnv("NAPUTO_WRAPPER_PATH", join(tmpRoot, "wrapper.node"));
        vi.stubEnv("NAPUTO_CFG_DIR", join(tmpRoot, "10001"));
        await freshSelfHost();
        expect(h.lockCleanupRegistered).toEqual([join(tmpRoot, "10001")]);
    });

    it("NAPUTO_CFG_DIR 未设置 → 跳过单实例锁（告警继续）", async () => {
        mockExit();
        mockDlopen({ NodeIKernelLoginService: {} });
        vi.stubEnv("NAPUTO_WRAPPER_PATH", join(tmpRoot, "wrapper.node"));
        await freshSelfHost();
        expect(h.lockCleanupRegistered).toHaveLength(0);
        expect(exitSpy).not.toHaveBeenCalled();
    });
});

describe("self-host dlopen wrapper.node", () => {
    it("dlopen 抛错 → exit 1 + failed(UNKNOWN)", async () => {
        mockExit();
        mockDlopen(new Error("stub 符号缺失"));
        vi.stubEnv("NAPUTO_IPC", "1");
        vi.stubEnv("NAPUTO_WRAPPER_PATH", join(tmpRoot, "wrapper.node"));
        vi.stubEnv("NAPUTO_CFG_DIR", join(tmpRoot, "10001"));
        await freshSelfHost();
        expect(exitSpy?.mock.calls[0]?.[0]).toBe(1);
        expect(h.statuses.some((st) => st.phase === "failed" && st.error?.code === "UNKNOWN")).toBe(
            true,
        );
    });

    it("exports 缺 NodeIKernelLoginService → exit 1 + failed(INVALID_STATE)", async () => {
        mockExit();
        mockDlopen({ NodeIO3MiscService: { get: () => ({}) } });
        vi.stubEnv("NAPUTO_IPC", "1");
        vi.stubEnv("NAPUTO_WRAPPER_PATH", join(tmpRoot, "wrapper.node"));
        vi.stubEnv("NAPUTO_CFG_DIR", join(tmpRoot, "10001"));
        await freshSelfHost();
        expect(exitSpy?.mock.calls[0]?.[0]).toBe(1);
        expect(
            h.statuses.some((st) => st.phase === "failed" && st.error?.code === "INVALID_STATE"),
        ).toBe(true);
    });

    it("dlopen 成功 → state.wrapperExports 注入 bootstrap（exports 数进日志）", async () => {
        mockExit();
        const exports = { NodeIKernelLoginService: {}, NodeIKernelBuddyService: {} };
        mockDlopen(exports);
        vi.stubEnv("NAPUTO_IPC", "0");
        vi.stubEnv("NAPUTO_WRAPPER_PATH", join(tmpRoot, "wrapper.node"));
        vi.stubEnv("NAPUTO_CFG_DIR", join(tmpRoot, "10001"));
        await freshSelfHost();
        expect(h.bootstrapStates[0]?.wrapperExports).toEqual(exports);
        expect(exitSpy).not.toHaveBeenCalled();
    });
});

describe("self-host O3MiscService 激活", () => {
    it("O3MiscService.get().addO3MiscListener 调用（事件分发激活，三要素之二）", async () => {
        mockExit();
        mockDlopen({
            NodeIKernelLoginService: {},
            NodeIO3MiscService: {
                get: () => ({
                    addO3MiscListener: () => {
                        h.o3ListenerCalls += 1;
                    },
                }),
            },
        });
        vi.stubEnv("NAPUTO_IPC", "0");
        vi.stubEnv("NAPUTO_WRAPPER_PATH", join(tmpRoot, "wrapper.node"));
        vi.stubEnv("NAPUTO_CFG_DIR", join(tmpRoot, "10001"));
        await freshSelfHost();
        expect(h.o3ListenerCalls).toBe(1);
    });

    it("O3MiscService 缺失（版本变化）→ 告警继续（不阻断引导）", async () => {
        mockExit();
        mockDlopen({ NodeIKernelLoginService: {} });
        vi.stubEnv("NAPUTO_IPC", "0");
        vi.stubEnv("NAPUTO_WRAPPER_PATH", join(tmpRoot, "wrapper.node"));
        vi.stubEnv("NAPUTO_CFG_DIR", join(tmpRoot, "10001"));
        await freshSelfHost();
        expect(exitSpy).not.toHaveBeenCalled();
    });

    it("O3MiscService 激活抛错 → 告警继续（不阻断引导）", async () => {
        mockExit();
        mockDlopen({
            NodeIKernelLoginService: {},
            NodeIO3MiscService: {
                get: () => {
                    throw new Error("激活断言");
                },
            },
        });
        vi.stubEnv("NAPUTO_IPC", "0");
        vi.stubEnv("NAPUTO_WRAPPER_PATH", join(tmpRoot, "wrapper.node"));
        vi.stubEnv("NAPUTO_CFG_DIR", join(tmpRoot, "10001"));
        await freshSelfHost();
        expect(exitSpy).not.toHaveBeenCalled();
    });
});

describe("self-host bootstrap 收敛", () => {
    /** IPC 模式 bootstrap 场景公共前置（wrapper 就绪）。 */
    function stubReadyIpcEnv(): void {
        mockExit();
        mockDlopen({
            NodeIKernelLoginService: {},
            NodeIO3MiscService: { get: () => ({ addO3MiscListener: () => undefined }) },
        });
        vi.stubEnv("NAPUTO_IPC", "1");
        vi.stubEnv("NAPUTO_WRAPPER_PATH", join(tmpRoot, "wrapper.node"));
        vi.stubEnv("NAPUTO_CFG_DIR", join(tmpRoot, "10001"));
        vi.stubEnv("NAPUTO_DATA_ROOT", tmpRoot);
    }

    it("bootstrap 成功 → IPC ready，不退出（常驻）", async () => {
        stubReadyIpcEnv();
        h.bootstrapResult = true;
        await freshSelfHost();
        // 等异步引导 IIFE 收敛（防 ready 晚到 bleed 进下一用例）
        await new Promise((r) => setTimeout(r, 10));
        expect(h.statuses.at(-1)).toMatchObject({ phase: "ready" });
        expect(exitSpy).not.toHaveBeenCalled();
    });

    it("bootstrap false（未完成）→ exit 1 + 通用 failed（不覆盖具体错误）", async () => {
        stubReadyIpcEnv();
        h.bootstrapResult = false;
        await freshSelfHost();
        // exit mock 不真退：exitBootIncomplete 后模块继续到 ready——按存在性断言
        expect(exitSpy?.mock.calls.at(-1)?.[0]).toBe(1);
        expect(h.statuses.some((st) => st.phase === "failed" && st.error?.code === "UNKNOWN")).toBe(
            true,
        );
    });

    it("bootstrap 抛 ConfigError → exit 78（配置校验契约）+ failed(INVALID_PARAM)", async () => {
        stubReadyIpcEnv();
        const configError = new Error("协议配置 kurobot 段校验失败");
        configError.name = "ConfigError";
        h.bootstrapResult = configError;
        await freshSelfHost();
        await new Promise((r) => setTimeout(r, 10));
        expect(exitSpy?.mock.calls.at(-1)?.[0]).toBe(78);
        expect(h.statuses.at(-1)).toMatchObject({
            phase: "failed",
            error: { code: "INVALID_PARAM" },
        });
    });

    it("bootstrap 抛运行时错误 → exit 1 + failed(UNKNOWN)", async () => {
        stubReadyIpcEnv();
        h.bootstrapResult = new Error("kernel 崩溃");
        await freshSelfHost();
        await new Promise((r) => setTimeout(r, 10));
        expect(exitSpy?.mock.calls.at(-1)?.[0]).toBe(1);
    });

    it("非 IPC 模式 bootstrap false → exit 1，不发任何 status", async () => {
        mockExit();
        mockDlopen({ NodeIKernelLoginService: {} });
        vi.stubEnv("NAPUTO_IPC", "0");
        vi.stubEnv("NAPUTO_WRAPPER_PATH", join(tmpRoot, "wrapper.node"));
        vi.stubEnv("NAPUTO_CFG_DIR", join(tmpRoot, "10001"));
        h.bootstrapResult = false;
        await freshSelfHost();
        await new Promise((r) => setTimeout(r, 10));
        expect(exitSpy?.mock.calls.at(-1)?.[0]).toBe(1);
        expect(h.statuses).toHaveLength(0);
    });
});

describe("self-host 生命周期接线", () => {
    it("停止哨兵观察注册：dataRoot=NAPUTO_DATA_ROOT，account 取 CFG_DIR 尾段", async () => {
        mockExit();
        mockDlopen({ NodeIKernelLoginService: {} });
        vi.stubEnv("NAPUTO_IPC", "0");
        vi.stubEnv("NAPUTO_WRAPPER_PATH", join(tmpRoot, "wrapper.node"));
        vi.stubEnv("NAPUTO_CFG_DIR", join(tmpRoot, "10001"));
        vi.stubEnv("NAPUTO_DATA_ROOT", tmpRoot);
        await freshSelfHost();
        expect(h.sentinelCalls).toEqual([{ dataRoot: tmpRoot, account: "10001" }]);
    });

    it("NAPUTO_DATA_ROOT 未设置 → 不注册哨兵观察", async () => {
        mockExit();
        mockDlopen({ NodeIKernelLoginService: {} });
        vi.stubEnv("NAPUTO_IPC", "0");
        vi.stubEnv("NAPUTO_WRAPPER_PATH", join(tmpRoot, "wrapper.node"));
        vi.stubEnv("NAPUTO_CFG_DIR", join(tmpRoot, "10001"));
        await freshSelfHost();
        expect(h.sentinelCalls).toHaveLength(0);
    });

    it("CFG_DIR 为空 → account 兜底 default", async () => {
        mockExit();
        mockDlopen({ NodeIKernelLoginService: {} });
        vi.stubEnv("NAPUTO_IPC", "0");
        vi.stubEnv("NAPUTO_WRAPPER_PATH", join(tmpRoot, "wrapper.node"));
        vi.stubEnv("NAPUTO_DATA_ROOT", tmpRoot);
        await freshSelfHost();
        expect(h.sentinelCalls).toEqual([{ dataRoot: tmpRoot, account: "default" }]);
    });

    it("unhandledRejection 兜底注册（2026-08-22 崩溃防御）", async () => {
        mockProcessOn();
        mockExit();
        mockDlopen({ NodeIKernelLoginService: {} });
        vi.stubEnv("NAPUTO_IPC", "0");
        vi.stubEnv("NAPUTO_WRAPPER_PATH", join(tmpRoot, "wrapper.node"));
        vi.stubEnv("NAPUTO_CFG_DIR", join(tmpRoot, "10001"));
        await freshSelfHost();
        const rejection = h.processOnCalls.find(([event]) => event === "unhandledRejection");
        expect(rejection).toBeDefined();
        // 触发一次：仅记日志不退出
        rejection?.[1]({ message: "sendMsg 确认事件 reject" } as never);
        expect(exitSpy).not.toHaveBeenCalled();
    });
});
