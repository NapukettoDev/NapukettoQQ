import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
    bootstrap: vi.fn<() => Promise<boolean>>(),
    acquireLock: vi.fn<() => boolean>(),
    registerLockCleanup: vi.fn(),
    requestShutdown: vi.fn<() => Promise<void>>(),
    watchStopSentinel: vi.fn(() => () => undefined),
    sendStatus: vi.fn(),
    startServer: vi.fn(() => () => undefined),
    enableIpc: vi.fn<(onLost: () => void) => void>(),
    phase: null as string | null,
}));

vi.mock("../../src/lifecycle/instance-lock.js", () => ({
    acquireInstanceLock: h.acquireLock,
    checkInstanceLock: () => ({ pid: 321 }),
    registerLockCleanup: h.registerLockCleanup,
}));

vi.mock("../../src/lifecycle/shutdown.js", () => ({
    installSignalShutdown: vi.fn(),
    isShuttingDown: () => false,
    registerShutdownHook: vi.fn(),
    requestShutdown: h.requestShutdown,
    watchStopSentinel: h.watchStopSentinel,
}));

// IPC 层按具体模块替换（2026-11-25 P2 移除 host/ipc/index.ts barrel）。
vi.mock("../../src/host/ipc/sender.js", () => ({
    enableIpc: h.enableIpc,
    flushIpc: vi.fn(),
    lastIpcStatusPhase: () => h.phase,
    sendStatus: h.sendStatus,
    shouldSendGenericBootFailed: (ipcMode: boolean, lastPhase: string | null) =>
        ipcMode && lastPhase !== "failed",
}));

vi.mock("../../src/host/ipc/server.js", () => ({
    startIpcServer: h.startServer,
}));

vi.mock("../../src/host/bootstrap/bootstrap.js", () => ({ bootstrap: h.bootstrap }));
vi.mock("../../src/host/bootstrap/media-patch-status.js", () => ({
    reportMediaPatchStatus: vi.fn(),
}));

beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    h.phase = null;
    h.acquireLock.mockReturnValue(true);
    h.bootstrap.mockResolvedValue(true);
    h.requestShutdown.mockResolvedValue();
    vi.stubEnv("NAPUKETTO_IPC", "1");
    vi.stubEnv("NAPUKETTO_WRAPPER_PATH", "synthetic-wrapper.node");
    vi.stubEnv("NAPUKETTO_CFG_DIR", "fixture/10001");
    vi.stubEnv("NAPUKETTO_DATA_ROOT", "fixture");
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process, "on").mockImplementation(() => process);
});

afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});

describe("self-host 入口", () => {
    it("引导前启动 stdin，接通 stdout 故障和账户级哨兵", async () => {
        await import("../../src/host/self-host.js");
        expect(h.startServer).toHaveBeenCalledBefore(h.bootstrap);
        expect(h.registerLockCleanup).toHaveBeenCalledWith("fixture/10001");
        expect(h.watchStopSentinel).toHaveBeenCalledWith(
            expect.objectContaining({
                account: "10001",
                dataRoot: "fixture",
            }),
        );
        expect(h.sendStatus).toHaveBeenCalledWith("booting");
        expect(h.requestShutdown).not.toHaveBeenCalled();
        h.enableIpc.mock.calls[0]?.[0]();
        expect(h.requestShutdown).toHaveBeenCalledWith("IPC stdout 已失效");
    });

    it("获取锁失败时不引导，报告 INVALID_STATE 并关停", async () => {
        h.acquireLock.mockReturnValue(false);
        await import("../../src/host/self-host.js");
        expect(h.bootstrap).not.toHaveBeenCalled();
        expect(h.registerLockCleanup).not.toHaveBeenCalled();
        expect(h.sendStatus).toHaveBeenLastCalledWith(
            "failed",
            expect.any(String),
            expect.objectContaining({ code: "INVALID_STATE" }),
        );
        expect(h.requestShutdown).toHaveBeenCalledWith("引导失败", 1);
    });

    it("具体失败状态保留，统一关停并退出 1", async () => {
        h.phase = "failed";
        h.bootstrap.mockResolvedValue(false);
        await import("../../src/host/self-host.js");
        expect(h.sendStatus).toHaveBeenCalledExactlyOnceWith("booting");
        expect(h.requestShutdown).toHaveBeenCalledWith("引导失败", 1);
    });

    it("配置校验错误保留退出码 78", async () => {
        h.bootstrap.mockRejectedValue(
            Object.assign(new Error("fixture config"), { name: "ConfigError" }),
        );
        await import("../../src/host/self-host.js");
        expect(h.sendStatus).toHaveBeenLastCalledWith(
            "failed",
            expect.any(String),
            expect.objectContaining({ code: "INVALID_PARAM" }),
        );
        expect(h.requestShutdown).toHaveBeenCalledWith("引导失败", 78);
    });
});
